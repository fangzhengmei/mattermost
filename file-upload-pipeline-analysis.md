# Mattermost 文件上传链路分析报告

## 1. 整体架构概览

Mattermost 的文件上传系统采用分层架构设计，从客户端到服务端形成完整的数据流转链路：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              客户端 (Webapp)                                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────────┐  │
│  │ 普通上传      │    │ 分片上传      │    │ 文件展示/下载                │  │
│  │ multipart    │    │ /uploads     │    │ /files/{id}, /preview等     │  │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┬───────────────┘  │
└─────────┼───────────────────┼────────────────────────────┼────────────────────┘
          │                   │                            │
          ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            API 层 (api4/file.go, upload.go)                  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  权限校验 (upload_file 权限 + ABAC + 频道成员校验)                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  端点: POST /files, POST /uploads, GET /files/{id}, /preview, /thumbnail│  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────┬───────────────────┬────────────────────────────┼────────────────────┘
          │                   │                            │
          ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          业务逻辑层 (app/file.go, upload.go)                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────────┐  │
│  │ UploadFileX  │    │ UploadData   │    │ 图片预处理/后处理             │  │
│  │ 核心上传函数  │    │ 分片上传处理  │    │ 缩略图/预览图生成            │  │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┬───────────────┘  │
│         │                    │                             │                   │
│         ▼                    ▼                             ▼                   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        插件钩子 (FileWillBeUploaded 等)                  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────┬───────────────────┬────────────────────────────┼────────────────────┘
          │                   │                            │
          ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          存储层 (filestore/)                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    FileBackend 接口 (策略模式)                            │  │
│  │  ┌─────────────────┐          ┌─────────────────────────────────────┐  │  │
│  │  │ LocalFileBackend│          │ S3FileBackend (minio-go)            │  │  │
│  │  │ 本地文件系统      │          │ AWS S3 / MinIO / 其他兼容存储        │  │  │
│  │  └─────────────────┘          └─────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────┬───────────────────┬────────────────────────────┼────────────────────┘
          │                   │                            │
          ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          数据层 (store/FileInfoStore)                          │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  FileInfo 表: 存储文件元数据 (路径、尺寸、MIME类型、缩略图路径等)          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────┬────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        消息关联层 (app/post_file_change.go)                    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Post.FileIds ↔ FileInfo.PostId 双向关联                                  │  │
│  │  processPostFileChanges: 创建/更新帖子时处理文件关联                      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 客户端上传流程

### 2.1 两种上传模式

Mattermost 支持两种文件上传模式，分别适用于不同场景：

#### 普通上传 (Multipart Upload)
适用于中小文件，一次性上传完成。

**API 端点**: `POST /api/v4/files`

**请求格式**: `multipart/form-data`

**核心字段**:
- `channel_id`: 目标频道 ID
- `files`: 文件内容（支持多文件）
- `client_ids`: 客户端生成的临时 ID（用于追踪上传状态）

**代码位置**: `server/channels/api4/file.go:77-130`

```go
func uploadFileStream(c *Context, w http.ResponseWriter, r *http.Request) {
    // 解析请求，支持两种格式：
    // 1. multipart/form-data (标准)
    // 2. simple POST (body 为文件内容，参数在 URL)
    _, err := parseMultipartRequestHeader(r)
    switch err {
    case nil:
        fileUploadResponse = uploadFileMultipart(c, r, nil, timestamp)
    case http.ErrNotMultipart:
        fileUploadResponse = uploadFileSimple(c, r, timestamp)
    }
}
```

#### 分片上传 (Resumable Upload)
适用于大文件，支持断点续传。

**API 端点**:
1. `POST /api/v4/uploads` - 创建上传会话
2. `POST /api/v4/uploads/{upload_id}` - 上传数据块

**流程**:
1. 客户端先创建上传会话，告知服务器文件名、总大小、目标频道
2. 服务器返回 `upload_id` 和初始 `file_offset`
3. 客户端分块上传数据，每次更新 `file_offset`
4. 当 `file_offset == file_size` 时，上传完成，生成 `FileInfo`

**代码位置**: `server/channels/api4/upload.go:20-207`

**最小分片大小**: 5MB (`minFirstPartSize = 5 * 1024 * 1024`)

```go
// 创建上传会话
func createUpload(c *Context, w http.ResponseWriter, r *http.Request) {
    var us model.UploadSession
    json.NewDecoder(r.Body).Decode(&us)
    
    us.Id = model.NewId()
    us.FileOffset = 0
    us.Path = now.Format("20060102") + "/teams/noteam/channels/" + 
               us.ChannelId + "/users/" + us.UserId + "/" + 
               us.Id + "/" + filepath.Base(us.Filename)
    
    rus, err := c.App.CreateUploadSession(c.AppContext, &us)
}
```

---

## 3. 服务端 API 层与权限校验

### 3.1 API 端点概览

| 端点 | 方法 | 功能 | 权限要求 |
|------|------|------|----------|
| `/api/v4/files` | POST | 上传文件 | `upload_file` |
| `/api/v4/uploads` | POST | 创建分片上传会话 | `upload_file` |
| `/api/v4/uploads/{id}` | GET | 获取上传会话状态 | 会话所有者或系统管理员 |
| `/api/v4/uploads/{id}` | POST | 上传数据块 | 会话所有者 |
| `/api/v4/files/{id}` | GET | 下载文件 | 频道读取权限 |
| `/api/v4/files/{id}/preview` | GET | 获取预览图 | 频道读取权限 |
| `/api/v4/files/{id}/thumbnail` | GET | 获取缩略图 | 频道读取权限 |
| `/api/v4/files/{id}/info` | GET | 获取文件元数据 | 频道读取权限 |
| `/api/v4/files/{id}/link` | GET | 生成公开链接 | 频道读取权限 |
| `/api/v4/files/{id}/public` | GET | 公开访问文件 | 仅需 hash 验证 |

### 3.2 权限校验环节

权限校验发生在多个层级，形成纵深防御：

#### 第一层: 会话验证
所有文件相关端点都使用 `APISessionRequired` 或 `APISessionRequiredTrustRequester` 中间件，确保请求来自已登录用户。

**代码位置**: `server/channels/api4/file.go:33-45`

```go
func (api *API) InitFile() {
    api.BaseRoutes.Files.Handle("", 
        api.APISessionRequired(uploadFileStream, handlerParamFileAPI)).Methods(http.MethodPost)
    api.BaseRoutes.File.Handle("", 
        api.APISessionRequiredTrustRequester(getFile)).Methods(http.MethodGet, http.MethodHead)
    api.BaseRoutes.File.Handle("/preview", 
        api.APISessionRequiredTrustRequester(getFilePreview)).Methods(http.MethodGet, http.MethodHead)
}
```

#### 第二层: 上传权限校验

上传时进行三重校验：

**1. RBAC 权限检查** (`model.PermissionUploadFile`)
```go
// server/channels/api4/file.go:145-148
if ok, _ := c.App.SessionHasPermissionToChannel(c.AppContext, 
    *c.AppContext.Session(), c.Params.ChannelId, model.PermissionUploadFile); !ok {
    c.SetPermissionError(model.PermissionUploadFile)
    return nil
}
```

**2. ABAC 权限检查** (基于属性的访问控制)
```go
// server/channels/api4/file.go:150-153
if !c.App.HasPermissionToFileAction(c.AppContext, 
    c.AppContext.Session().UserId, 
    c.AppContext.Session().Roles, 
    c.Params.ChannelId, 
    model.AccessControlPolicyActionUploadFileAttachment) {
    c.Err = model.NewAppError("uploadFileSimple", 
        "api.file.upload_file.abac_denied.app_error", nil, "", http.StatusForbidden)
    return nil
}
```

**3. 频道有效性检查**
- 验证频道存在且未被删除
- 检查是否为受限 DM (Restricted Direct Message)

```go
// server/channels/api4/file.go:155-172
channel, err := c.App.GetChannel(c.AppContext, c.Params.ChannelId)
if err != nil {
    c.Err = model.NewAppError("uploadFileSimple",
        "api.file.upload_file.get_channel.app_error",
        nil, err.Error(), http.StatusBadRequest)
    return nil
}

restrictDM, appErr := c.App.CheckIfChannelIsRestrictedDM(c.AppContext, channel)
if restrictDM {
    c.Err = model.NewAppError("uploadFileSimple", 
        "api.file.upload_file.restricted_dm.error", nil, "", http.StatusBadRequest)
    return nil
}
```

#### 第三层: 下载/预览权限校验

下载文件时的权限检查：

```go
// server/channels/api4/file.go:588-604
// 1. 检查频道读取权限
perm, isMember := c.App.SessionHasPermissionToReadChannel(c.AppContext, 
    *c.AppContext.Session(), channel)

// 2. 特殊处理: 书签文件 (BookmarkFileOwner) 和自己上传的文件
if fileInfo.CreatorId == model.BookmarkFileOwner {
    if !perm {
        c.SetPermissionError(model.PermissionReadChannelContent)
        return
    }
} else if fileInfo.CreatorId != c.AppContext.Session().UserId && !perm {
    c.SetPermissionError(model.PermissionReadChannelContent)
    return
}

// 3. ABAC 下载权限检查
if !c.App.HasPermissionToFileAction(c.AppContext, 
    c.AppContext.Session().UserId, 
    c.AppContext.Session().Roles, 
    fileInfo.ChannelId, 
    model.AccessControlPolicyActionDownloadFileAttachment) {
    c.Err = model.NewAppError("getFile", 
        "api.file.get_file.abac_denied.app_error", nil, "", http.StatusForbidden)
    return
}

// 4. 插件钩子拦截
rejectionReason := c.App.RunFileWillBeDownloadedHook(c.AppContext, 
    fileInfo, c.AppContext.Session().UserId, 
    r.Header.Get(model.ConnectionId), model.FileDownloadTypeFile)
if rejectionReason != "" {
    // 插件拒绝下载
}
```

#### 第四层: 公开链接权限

公开链接使用 hash 验证机制，绕过会话检查：

```go
// server/channels/api4/file.go:908-912
hash := r.URL.Query().Get("h")

// 使用常量时间比较防止时序攻击
if subtle.ConstantTimeCompare([]byte(hash), 
    []byte(app.GeneratePublicLinkHash(info.Id, 
    *c.App.Config().FileSettings.PublicLinkSalt))) != 1 {
    c.Err = model.NewAppError("getPublicFile", 
        "api.file.get_file.public_invalid.app_error", nil, "", http.StatusBadRequest)
    return
}
```

---

## 4. 存储后端适配

### 4.1 架构设计

Mattermost 使用**策略模式**实现存储后端的灵活切换，核心是 `FileBackend` 接口。

**代码位置**: `server/platform/shared/filestore/filesstore.go`

#### FileBackend 接口定义

```go
type FileBackend interface {
    DriverName() string
    TestConnection() error

    // 读操作
    Reader(path string) (ReadCloseSeeker, error)
    ReadFile(path string) ([]byte, error)
    FileExists(path string) (bool, error)
    FileSize(path string) (int64, error)
    FileModTime(path string) (time.Time, error)

    // 写操作
    WriteFile(fr io.Reader, path string) (int64, error)
    AppendFile(fr io.Reader, path string) (int64, error)
    CopyFile(oldPath, newPath string) error
    MoveFile(oldPath, newPath string) error
    RemoveFile(path string) error

    // 目录操作
    ListDirectory(path string) ([]string, error)
    ListDirectoryRecursively(path string) ([]string, error)
    RemoveDirectory(path string) error

    // 压缩
    ZipReader(path string, deflate bool) (io.ReadCloser, error)
}
```

#### 可选扩展接口

```go
// 支持生成预签名链接（S3 特有）
type FileBackendWithLinkGenerator interface {
    GeneratePublicLink(path string) (string, time.Duration, error)
}

// 支持上下文超时（用于长时操作）
type ContextWriter interface {
    WriteFileContext(context.Context, io.Reader, string) (int64, error)
}
```

### 4.2 后端实现

#### 本地文件系统 (LocalFileBackend)

**代码位置**: `server/platform/shared/filestore/localstore.go`

基于标准库 `os` 包实现，路径格式：

```
{配置的 Directory} / {相对路径}
```

**核心实现**:

```go
type LocalFileBackend struct {
    directory string
}

func (b *LocalFileBackend) WriteFile(fr io.Reader, path string) (int64, error) {
    return writeFileLocally(fr, filepath.Join(b.directory, path))
}

func writeFileLocally(fr io.Reader, path string) (int64, error) {
    // 自动创建目录
    if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
        return 0, errors.Wrapf(err, 
            "unable to create the directory %s for the file %s", 
            filepath.Dir(path), path)
    }
    
    // 写入文件，权限 0600
    fw, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
    if err != nil {
        return 0, errors.Wrapf(err, 
            "unable to open the file %s to write the data", path)
    }
    defer fw.Close()
    
    written, err := io.Copy(fw, fr)
    return written, err
}
```

**分片上传支持**: 使用 `os.O_APPEND` 标志实现追加写入

```go
func (b *LocalFileBackend) AppendFile(fr io.Reader, path string) (int64, error) {
    fp := filepath.Join(b.directory, path)
    // 使用 O_APPEND 标志
    fw, err := os.OpenFile(fp, os.O_WRONLY|os.O_APPEND, 0600)
    // ...
    written, err := io.Copy(fw, fr)
    return written, err
}
```

#### S3 兼容存储 (S3FileBackend)

**代码位置**: `server/platform/shared/filestore/s3store.go`

基于 `minio-go` 库实现，支持：
- AWS S3
- MinIO
- 其他 S3 API 兼容存储

**配置项** (`FileBackendSettings`):

| 字段 | 说明 |
|------|------|
| `AmazonS3AccessKeyId` | 访问密钥 ID |
| `AmazonS3SecretAccessKey` | 访问密钥 |
| `AmazonS3Bucket` | 存储桶名称 |
| `AmazonS3PathPrefix` | 路径前缀 |
| `AmazonS3Region` | 区域 |
| `AmazonS3Endpoint` | 端点 |
| `AmazonS3SSL` | 是否启用 SSL |
| `AmazonS3SignV2` | 是否使用 V2 签名 |
| `AmazonS3SSE` | 是否启用服务端加密 |
| `AmazonS3UploadPartSizeBytes` | 分片上传块大小 |
| `AmazonS3StorageClass` | 存储类别 |

**认证方式**:

```go
// s3store.go:140-150
var creds *credentials.Credentials

if isCloud {
    // Mattermost Cloud 专有认证
    creds = credentials.New(customProvider{isSignV2: b.signV2})
} else if b.accessKey == "" && b.secretKey == "" {
    // IAM 角色认证 (EC2/EKS 等环境)
    creds = credentials.NewIAM("")
} else if b.signV2 {
    // V2 签名 (旧版兼容)
    creds = credentials.NewStatic(b.accessKey, b.secretKey, "", credentials.SignatureV2)
} else {
    // V4 签名 (标准)
    creds = credentials.NewStatic(b.accessKey, b.secretKey, "", credentials.SignatureV4)
}
```

**读取对象**:

```go
func (b *S3FileBackend) Reader(path string) (ReadCloseSeeker, error) {
    path, err := b.prefixedPath(path)  // 添加路径前缀
    
    ctx, cancel := context.WithCancel(context.Background())
    minioObject, err := b.client.GetObject(ctx, b.bucket, path, s3.GetObjectOptions{})
    
    // 封装为带超时取消的 reader
    sc := &s3WithCancel{
        Object: minioObject,
        timer:  time.AfterFunc(b.timeout, cancel),
        cancel: cancel,
    }
    return sc, nil
}
```

### 4.3 工厂模式与配置映射

**后端创建工厂**:

```go
// filesstore.go:146-164
func newFileBackend(settings FileBackendSettings, canBeCloud bool) (FileBackend, error) {
    switch settings.DriverName {
    case driverS3: // "amazons3"
        newBackendFn := NewS3FileBackend
        if !canBeCloud {
            newBackendFn = NewS3FileBackendWithoutBifrost
        }
        backend, err := newBackendFn(settings)
        return backend, nil
        
    case driverLocal: // "local"
        return &LocalFileBackend{
            directory: settings.Directory,
        }, nil
    }
    return nil, errors.New("no valid filestorage driver found")
}
```

**配置映射** (`FileSettings` → `FileBackendSettings`):

```go
func NewFileBackendSettingsFromConfig(fileSettings *model.FileSettings, 
    enableComplianceFeature bool, skipVerify bool) FileBackendSettings {
    
    if *fileSettings.DriverName == model.ImageDriverLocal {
        return FileBackendSettings{
            DriverName: *fileSettings.DriverName,
            Directory:  *fileSettings.Directory,
        }
    }
    
    // S3 配置
    return FileBackendSettings{
        DriverName:                         *fileSettings.DriverName,
        AmazonS3AccessKeyId:                *fileSettings.AmazonS3AccessKeyId,
        AmazonS3SecretAccessKey:            *fileSettings.AmazonS3SecretAccessKey,
        AmazonS3Bucket:                     *fileSettings.AmazonS3Bucket,
        AmazonS3PathPrefix:                 *fileSettings.AmazonS3PathPrefix,
        AmazonS3Region:                     *fileSettings.AmazonS3Region,
        AmazonS3Endpoint:                   *fileSettings.AmazonS3Endpoint,
        AmazonS3SSL:                        fileSettings.AmazonS3SSL == nil || *fileSettings.AmazonS3SSL,
        AmazonS3SSE:                        fileSettings.AmazonS3SSE != nil && 
                                             *fileSettings.AmazonS3SSE && enableComplianceFeature,
        // ... 更多配置
    }
}
```

### 4.4 文件路径规范

Mattermost 使用结构化的路径命名，便于管理和检索：

**普通附件路径格式**:
```
{日期}/teams/{teamId}/channels/{channelId}/users/{userId}/{fileId}/{filename}
```

示例:
```
20260502/teams/noteam/channels/abc123/users/xyz789/file001/report.pdf
```

**书签文件路径格式** (`BookmarkFileOwner`):
```
bookmarks/teams/{teamId}/channels/{channelId}/{fileId}/{filename}
```

**图片衍生文件** (预览图/缩略图):
```
{原路径前缀}/{文件名}_preview.{扩展名}
{原路径前缀}/{文件名}_thumb.{扩展名}
```

示例:
```
20260502/teams/.../photo.jpg
20260502/teams/.../photo_preview.jpg
20260502/teams/.../photo_thumb.jpg
```

**路径生成代码** (`app/file.go:1008-1020`):

```go
func (t UploadFileTask) pathPrefix() string {
    if t.UserId == model.BookmarkFileOwner {
        return model.BookmarkFileOwner +
            "/teams/" + t.TeamId +
            "/channels/" + t.ChannelId +
            "/" + t.fileinfo.Id + "/"
    }
    return t.Timestamp.Format("20060102") +
        "/teams/" + t.TeamId +
        "/channels/" + t.ChannelId +
        "/users/" + t.UserId +
        "/" + t.fileinfo.Id + "/"
}
```

---

## 5. 预览生成机制

### 5.1 图片类型识别与分类

**FileInfo 模型** (`server/public/model/file_info.go`):

```go
type FileInfo struct {
    Id              string
    CreatorId       string
    PostId          string
    ChannelId       string
    
    Name            string
    Extension       string
    MimeType        string
    Size            int64
    
    // 图片特有字段
    Width           int
    Height          int
    HasPreviewImage bool
    
    // 衍生文件路径
    Path            string      // 原始文件
    PreviewPath     string      // 预览图
    ThumbnailPath   string      // 缩略图
    
    MiniPreview     *[]byte     // 嵌入式微型预览 (base64)
}
```

**图片判断方法**:

```go
func (info *FileInfo) IsImage() bool {
    return strings.HasPrefix(info.MimeType, "image/")
}

func (info *FileInfo) IsSvg() bool {
    return info.MimeType == "image/svg+xml"
}
```

### 5.2 上传时的图片预处理

上传图片时，在写入存储前后会进行两次处理：

**流程**:
```
1. 读取文件头部 → 解码配置 → 获取宽高
2. 检查分辨率限制 (MaxImageResolution)
3. 读取 EXIF 方向信息 → 调整宽高
4. 写入原始文件到存储
5. 运行插件钩子
6. 生成预览图/缩略图/mini预览
7. 保存 FileInfo 到数据库
```

**预处理代码** (`app/file.go:872-929`):

```go
func (t *UploadFileTask) preprocessImage() *model.AppError {
    // SVG 特殊处理
    if t.fileinfo.IsSvg() {
        svgInfo, err := imaging.ParseSVG(t.teeInput)
        if err == nil && svgInfo.Width > 0 && svgInfo.Height > 0 {
            t.fileinfo.Width = svgInfo.Width
            t.fileinfo.Height = svgInfo.Height
        }
        t.fileinfo.HasPreviewImage = false  // SVG 不生成预览
        return nil
    }

    // 解码图片配置 (不加载全部像素)
    cfg, format, err := t.imgDecoder.DecodeConfig(t.teeInput)
    if err != nil {
        return nil  // 解码失败，当作普通文件处理
    }
    
    t.fileinfo.Width = cfg.Width
    t.fileinfo.Height = cfg.Height

    // 检查分辨率限制
    if err = checkImageResolutionLimit(cfg.Width, cfg.Height, t.maxImageRes); err != nil {
        return t.newAppError("api.file.upload_file.large_image_detailed.app_error", 
            http.StatusBadRequest).Wrap(err)
    }

    t.fileinfo.HasPreviewImage = true
    
    // 设置预览图和缩略图路径
    nameWithoutExtension := t.Name[:strings.LastIndex(t.Name, ".")]
    t.fileinfo.PreviewPath = t.pathPrefix() + nameWithoutExtension + "_preview." + 
                              getFileExtFromMimeType(t.fileinfo.MimeType)
    t.fileinfo.ThumbnailPath = t.pathPrefix() + nameWithoutExtension + "_thumb." + 
                                getFileExtFromMimeType(t.fileinfo.MimeType)

    // 读取 EXIF 方向，调整宽高
    if t.imageOrientation, err = imaging.GetImageOrientation(...); err == nil {
        if t.imageOrientation == imaging.RotatedCWMirrored ||
           t.imageOrientation == imaging.RotatedCCW ||
           t.imageOrientation == imaging.RotatedCCWMirrored ||
           t.imageOrientation == imaging.RotatedCW {
            // 旋转 90/270 度，交换宽高
            t.fileinfo.Width, t.fileinfo.Height = t.fileinfo.Height, t.fileinfo.Width
        }
    }

    // 动图 GIF 特殊处理
    if t.fileinfo.MimeType == "image/gif" {
        image, format, err := t.imgDecoder.Decode(...)
        if err == nil && image != nil {
            t.fileinfo.HasPreviewImage = false  // 动图不生成静态预览
            t.decoded = image                    // 缓存解码结果
            t.imageType = format
        }
    }

    return nil
}
```

### 5.3 图片后处理 - 生成衍生文件

**处理参数**:

| 类型 | 尺寸 | 格式 | 用途 |
|------|------|------|------|
| 缩略图 (Thumbnail) | 120x100 | JPEG | 消息列表预览 |
| 预览图 (Preview) | 宽度 1920px | JPEG/PNG | 点击查看大图 |
| 微型预览 (MiniPreview) | 16x16 | JPEG | 内嵌到 FileInfo |

**后处理代码** (`app/file.go:931-1006`):

```go
func (t *UploadFileTask) postprocessImage(file io.Reader) {
    if t.fileinfo.IsSvg() {
        return  // SVG 不处理
    }

    // 解码完整图片
    decoded, imgType := t.decoded, t.imageType
    if decoded == nil {
        var release func()
        decoded, imgType, release, err = t.imgDecoder.DecodeMemBounded(file)
        // ... 错误处理
        defer release()
    }

    // 根据 EXIF 方向转正图片
    decoded = imaging.MakeImageUpright(decoded, t.imageOrientation)

    // 并行生成三种衍生图片
    var wg sync.WaitGroup
    wg.Add(3)

    // 1. 生成缩略图
    go func() {
        defer wg.Done()
        writeImage(imaging.GenerateThumbnail(decoded, 
            imageThumbnailWidth, imageThumbnailHeight), 
            t.fileinfo.ThumbnailPath)
    }()

    // 2. 生成预览图
    go func() {
        defer wg.Done()
        writeImage(imaging.GeneratePreview(decoded, imagePreviewWidth), 
            t.fileinfo.PreviewPath)
    }()

    // 3. 生成微型预览
    go func() {
        defer wg.Done()
        if t.fileinfo.MiniPreview == nil {
            if miniPreview, err := imaging.GenerateMiniPreviewImage(decoded,
                miniPreviewImageWidth, miniPreviewImageHeight, jpegEncQuality); err != nil {
                t.Logger.Info("Unable to generate mini preview image", mlog.Err(err))
            } else {
                t.fileinfo.MiniPreview = &miniPreview
            }
        }
    }()

    wg.Wait()
}
```

**图片编码写入**:

```go
writeImage := func(img image.Image, path string) {
    r, w := io.Pipe()
    
    go func() {
        var err error
        if imgType == "png" {
            err = t.imgEncoder.EncodePNG(w, img)
        } else {
            err = t.imgEncoder.EncodeJPEG(w, img, jpegEncQuality)  // 质量 90
        }
        // ... 错误处理
        w.Close()
    }()
    
    // 通过管道流式写入存储
    _, aerr := t.writeFile(r, path)
    // ...
}
```

### 5.4 延迟生成 MiniPreview

MiniPreview 也可以在读取 FileInfo 时按需生成：

```go
// app/file.go:1230-1258
func (a *App) generateMiniPreview(rctx request.CTX, fi *model.FileInfo) {
    if fi.IsImage() && !fi.IsSvg() && fi.MiniPreview == nil {
        // 读取原始文件
        file, appErr := a.FileReader(fi.Path)
        if appErr != nil {
            return
        }
        defer file.Close()
        
        // 解码并处理
        img, _, release, err := prepareImage(rctx, a.ch.imgDecoder, file)
        if err != nil {
            return
        }
        defer release()
        
        // 生成 16x16 缩略图
        var miniPreview []byte
        if miniPreview, err = imaging.GenerateMiniPreviewImage(img,
            miniPreviewImageWidth, miniPreviewImageHeight, jpegEncQuality); err != nil {
            rctx.Logger().Info("Unable to generate mini preview image", mlog.Err(err))
        } else {
            fi.MiniPreview = &miniPreview
        }
        
        // 保存回数据库
        if _, err = a.Srv().Store().FileInfo().Upsert(rctx, fi); err != nil {
            rctx.Logger().Debug("Creating mini preview failed", mlog.Err(err))
        } else {
            a.Srv().Store().FileInfo().InvalidateFileInfosForPostCache(fi.PostId, false)
        }
    }
}
```

---

## 6. 消息关联与展示

### 6.1 数据模型关联

**Post 与 FileInfo 的关联方式**:

```
┌─────────────────┐         ┌─────────────────┐
│     Post        │         │    FileInfo     │
├─────────────────┤         ├─────────────────┤
│ Id (PK)         │◄────────┤ PostId (FK)     │
│ FileIds []string│────────►│                 │
│ ChannelId       │         │ ChannelId       │
│ UserId          │         │ CreatorId       │
└─────────────────┘         └─────────────────┘
```

**双向关联设计**:
- `Post.FileIds`: 有序的文件 ID 列表，决定展示顺序
- `FileInfo.PostId`: 反向引用，支持级联删除和查询

### 6.2 帖子创建/更新时的文件处理

**核心函数**: `processPostFileChanges`

**代码位置**: `server/channels/app/post_file_change.go:12-43`

```go
func (a *App) processPostFileChanges(rctx request.CTX, 
    newPost, oldPost *model.Post, 
    updatePostOptions *model.UpdatePostOptions) (model.StringArray, *model.AppError) {
    
    // 去重
    newFileIDs := model.RemoveDuplicateStrings(newPost.FileIds)
    oldFileIDs := model.RemoveDuplicateStrings(oldPost.FileIds)
    
    // 计算差异: 新增、删除、未变
    addedFileIDs, removedFileIDs, unchangedFileIDs := 
        utils.FindExclusives(newFileIDs, oldFileIDs)

    // 处理新增文件
    if len(addedFileIDs) > 0 {
        if updatePostOptions != nil && updatePostOptions.IsRestorePost {
            // 恢复帖子: 恢复软删除的文件记录
            err := a.Srv().Store().FileInfo().RestoreForPostByIds(rctx, 
                newPost.Id, addedFileIDs)
            // ...
        } else {
            // 普通新增: 将文件关联到帖子
            a.attachNewFilesToPost(rctx, newPost, addedFileIDs, unchangedFileIDs)
        }
    }

    // 处理删除文件
    if len(removedFileIDs) > 0 {
        if appErr := a.detachFilesFromPost(rctx, newPost.Id, removedFileIDs); appErr != nil {
            return nil, appErr
        }
    }

    // 缓存失效
    if len(addedFileIDs) > 0 || len(removedFileIDs) > 0 {
        a.Srv().Store().FileInfo().InvalidateFileInfosForPostCache(newPost.Id, false)
    }

    return newPost.FileIds, nil
}
```

### 6.3 文件关联逻辑

**attachNewFilesToPost** - 将上传的文件绑定到帖子：

```go
// post_file_change.go:45-62
func (a *App) attachNewFilesToPost(rctx request.CTX, post *model.Post, 
    addedFileIDs, unchangedFileIDs []string) {
    
    // 注意：使用 session 用户 ID 而非帖子作者 ID
    // 支持管理员在他人帖子中附加文件
    userId := rctx.Session().UserId
    
    attachedFileIDs := a.attachFileIDsToPost(rctx, 
        post.Id, post.ChannelId, userId, addedFileIDs)
    
    // 如果部分文件无法关联，保留成功的 + 未变更的
    if len(attachedFileIDs) != len(addedFileIDs) {
        post.FileIds = append(attachedFileIDs, unchangedFileIDs...)
    }
}
```

**attachFileIDsToPost** 的核心逻辑 (在 `app/file.go` 中):

```go
func (a *App) attachFileIDsToPost(rctx request.CTX, postId, channelId, userId string, 
    fileIDs []string) []string {
    
    var attachedFileIDs []string
    
    for _, fileID := range fileIDs {
        // 验证文件: 未被删除、属于当前用户、频道匹配
        fileInfo, err := a.Srv().Store().FileInfo().GetForUser(fileID, userId, channelId)
        if err != nil {
            rctx.Logger().Warn("Unable to attach file to post", 
                mlog.String("file_id", fileID), mlog.Err(err))
            continue
        }
        
        // 跳过已关联到其他帖子的文件
        if fileInfo.PostId != "" {
            rctx.Logger().Warn("File already attached to another post", 
                mlog.String("file_id", fileID))
            continue
        }
        
        // 更新 FileInfo.PostId
        err = a.Srv().Store().FileInfo().AttachToPost(fileID, postId, userId)
        if err != nil {
            rctx.Logger().Warn("Failed to attach file to post", 
                mlog.String("file_id", fileID), mlog.Err(err))
            continue
        }
        
        attachedFileIDs = append(attachedFileIDs, fileID)
    }
    
    return attachedFileIDs
}
```

### 6.4 文件解除关联与软删除

**detachFilesFromPost**:

```go
// post_file_change.go:64-70
func (a *App) detachFilesFromPost(rctx request.CTX, postId string, 
    removedFileIDs []string) *model.AppError {
    
    // 软删除: 标记 DeleteAt，不实际删除文件
    if err := a.Srv().Store().FileInfo().DeleteForPostByIds(rctx, 
        postId, removedFileIDs); err != nil {
        return model.NewAppError("app.detachFilesFromPost", 
            "app.file_info.delete_for_post_ids.app_error", 
            map[string]any{"post_id": postId}, "", 0).Wrap(err)
    }
    return nil
}
```

### 6.5 展示流程

#### API 层获取帖子文件

当客户端请求帖子列表时，服务端通过以下方式获取关联的文件信息：

```go
// 获取单个帖子的文件
fileInfos, err := a.Srv().Store().FileInfo().GetForPost(post.Id, 
    true,    // 允许从缓存获取
    false,   // 不包含已删除的
    false)   // 不分页

// 批量获取帖子的文件
fileInfosMap, err := a.Srv().Store().FileInfo().GetForPosts(postIds, 
    true,    // 从缓存
    true)    // 仅获取已删帖子的文件 (内容审核场景)
```

#### 客户端展示

Webapp 端的文件展示逻辑 (`webapp/channels/src/components/file_upload/`):

1. **上传中状态**: 显示进度条、client_id 临时标识
2. **上传完成**: 使用返回的 `file_id` 替换 `client_id`
3. **消息渲染**:
   - 图片: 显示缩略图，点击加载预览图
   - 非图片: 显示文件图标、名称、大小
   - MiniPreview: 用于消息列表中的小图标

#### 文件下载端点的缓存策略

```go
// api4/file.go:868
w.Header().Set("Cache-Control", "max-age=2592000, private")  // 30 天私有缓存
```

---

## 7. 异步处理与扩展点

### 7.1 文件内容提取 (Content Extraction)

用于全文搜索，上传后异步执行：

```go
// app/file.go:859-867
if *a.Config().FileSettings.ExtractContent && t.ExtractContent {
    infoCopy := *t.fileinfo
    // 异步 goroutine 执行
    a.Srv().GoBuffered(func() {
        err := a.ExtractContentFromFileInfo(rctx, &infoCopy)
        if err != nil {
            rctx.Logger().Error("Failed to extract file content", 
                mlog.Err(err), mlog.String("fileInfoId", infoCopy.Id))
        }
    })
}
```

**提取内容存储**: `FileInfo.Content` 字段，用于后续搜索。

### 7.2 插件钩子

#### 上传时钩子

```go
// app/upload.go:56-128
func (a *App) runPluginsHook(rctx request.CTX, info *model.FileInfo, file io.Reader) *model.AppError {
    // 使用管道避免全量加载到内存
    r, w := io.Pipe()
    
    go func() {
        defer w.Close()
        a.ch.RunMultiHook(func(hooks plugin.Hooks, _ *model.Manifest) bool {
            // 插件可以:
            // 1. 拒绝上传 (返回 rejectionReason)
            // 2. 修改 FileInfo (返回 newInfo)
            // 3. 修改文件内容 (写入 newBytes)
            newInfo, rejStr := hooks.FileWillBeUploaded(pluginContext, info, file, w)
            
            if rejStr != "" {
                rejErr = model.NewAppError("runPluginsHook", 
                    "app.upload.run_plugins_hook.rejected", ...)
                return false
            }
            if newInfo != nil {
                info = newInfo
            }
            return true
        }, plugin.FileWillBeUploadedID)
    }()
    
    // 读取管道，写入临时文件
    tmpPath := filePath + ".tmp"
    written, err := a.WriteFile(r, tmpPath)
    // ...
    
    // 如果插件修改了内容，替换原文件
    if written > 0 {
        info.Size = written
        if fileErr := a.MoveFile(tmpPath, info.Path); fileErr != nil {
            return fileErr
        }
    }
    
    return rejErr
}
```

#### 下载时钩子

```go
// api4/file.go:606-614
rejectionReason := c.App.RunFileWillBeDownloadedHook(c.AppContext, 
    fileInfo, c.AppContext.Session().UserId, 
    r.Header.Get(model.ConnectionId), model.FileDownloadTypeFile)

if rejectionReason != "" {
    w.Header().Set(model.HeaderRejectReason, rejectionReason)
    c.Err = model.NewAppError("getFile", 
        "api.file.get_file.rejected_by_plugin",
        map[string]any{"Reason": rejectionReason}, "", http.StatusForbidden)
    return
}
```

**下载类型枚举**:
- `FileDownloadTypeFile` - 原始文件
- `FileDownloadTypeThumbnail` - 缩略图
- `FileDownloadTypePreview` - 预览图
- `FileDownloadTypePublic` - 公开链接下载

---

## 8. 关键配置项

### FileSettings 配置

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `EnableFileAttachments` | bool | 全局开关 |
| `MaxFileSize` | int64 | 单文件大小限制 (字节) |
| `DriverName` | string | `local` 或 `amazons3` |
| `Directory` | string | 本地存储路径 |
| `ExtractContent` | bool | 是否提取内容用于搜索 |
| `MaxImageResolution` | int64 | 图片像素限制 (宽×高) |
| `EnablePublicLink` | bool | 是否允许公开链接 |
| `PublicLinkSalt` | string | 公开链接哈希盐值 |

### S3 特有配置

| 配置项 | 说明 |
|--------|------|
| `AmazonS3Bucket` | 存储桶名 |
| `AmazonS3Region` | 区域 |
| `AmazonS3Endpoint` | 端点 (如 `s3.amazonaws.com`) |
| `AmazonS3AccessKeyId` / `SecretAccessKey` | 凭证 |
| `AmazonS3PathPrefix` | 路径前缀 |
| `AmazonS3SSL` | 是否使用 HTTPS |
| `AmazonS3SSE` | 服务端加密 |
| `AmazonS3UploadPartSizeBytes` | 分片大小 |

---

## 9. 总结

### 权限校验环节汇总

| 阶段 | 校验内容 | 代码位置 |
|------|----------|----------|
| **上传前** | 会话有效性 | `APISessionRequired` |
| **上传时** | RBAC: `upload_file` 权限 | `SessionHasPermissionToChannel` |
| **上传时** | ABAC: 上传附件策略 | `HasPermissionToFileAction` |
| **上传时** | 频道有效性 (非删除/非受限 DM) | `GetChannel`, `CheckIfChannelIsRestrictedDM` |
| **下载前** | 会话有效性 | `APISessionRequiredTrustRequester` |
| **下载时** | 频道读取权限 | `SessionHasPermissionToReadChannel` |
| **下载时** | 特殊: 自己的文件/书签文件 | `CreatorId` 判断 |
| **下载时** | ABAC: 下载附件策略 | `HasPermissionToFileAction` |
| **下载时** | 插件拦截 | `RunFileWillBeDownloadedHook` |
| **公开链接** | Hash 校验 (常量时间比较) | `subtle.ConstantTimeCompare` |

### 存储后端适配要点

1. **接口抽象**: `FileBackend` 定义了完整的文件操作契约
2. **策略模式**: `NewFileBackend` 工厂根据配置动态选择实现
3. **统一配置**: `FileBackendSettings` 统一本地和 S3 配置
4. **能力扩展**: 可选接口 `FileBackendWithLinkGenerator`, `ContextWriter`
5. **S3 特性**: 支持 V2/V4 签名、IAM 角色、服务端加密、预签名 URL

### 端到端流程示例

**上传文件并发送消息**:

```
1. Webapp → POST /api/v4/files (multipart)
   └─> 校验: session, upload_file 权限, ABAC, 频道存在
   
2. API 层 → app.UploadFileX()
   ├─> 预处理: 图片解码, 分辨率检查, EXIF 方向
   ├─> 写入存储: backend.WriteFile()  (local 或 S3)
   ├─> 插件钩子: FileWillBeUploaded
   ├─> 后处理: 生成 thumbnail/preview/mini_preview
   ├─> 提取内容: 异步 ExtractContentFromFileInfo
   └─> 保存 FileInfo 到数据库 (PostId = "" 暂未关联)

3. Webapp → POST /api/v4/posts
   ├─> Post.FileIds = [上传返回的 file_id]
   └─> app.processPostFileChanges()
       ├─> 验证文件属于当前用户且未关联
       └─> 更新 FileInfo.PostId = post.Id

4. 消息渲染
   └─> 客户端根据 FileInfo 类型显示:
       - 图片: <img src="/api/v4/files/{id}/thumbnail">
       - 其他: 文件图标 + 名称 + 下载链接
```

---

## 附录: 核心代码文件索引

| 功能模块 | 文件路径 |
|----------|----------|
| API 层 - 上传端点 | `server/channels/api4/file.go` |
| API 层 - 分片上传 | `server/channels/api4/upload.go` |
| 业务逻辑 - 核心上传 | `server/channels/app/file.go` |
| 业务逻辑 - 分片上传 | `server/channels/app/upload.go` |
| 业务逻辑 - 消息关联 | `server/channels/app/post_file_change.go` |
| 存储后端 - 接口定义 | `server/platform/shared/filestore/filesstore.go` |
| 存储后端 - 本地实现 | `server/platform/shared/filestore/localstore.go` |
| 存储后端 - S3 实现 | `server/platform/shared/filestore/s3store.go` |
| 数据模型 - FileInfo | `server/public/model/file_info.go` |
| 图片处理 | `server/channels/app/imaging/` |
| 内容提取 | `server/platform/services/docextractor/` |
