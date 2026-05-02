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
│  │  │ WriteFile       │          │ WriteFile (multipart upload)        │  │  │
│  │  │ AppendFile      │          │                                   │  │  │
│  │  └─────────────────┘          └─────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────┬───────────────────┬────────────────────────────┼────────────────────┘
          │                   │                            │
          ▼                   ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          数据层 (store/)                                        │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐  │
│  │    FileInfoStore            │    │      UploadSessionStore             │  │
│  │  存储文件元数据              │    │  存储分片上传会话状态                │  │
│  │  (PostId, Path, Size等)    │    │  (FileOffset, FileSize, Path等)    │  │
│  └─────────────────────────────┘    └─────────────────────────────────────┘  │
└─────────┬────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        消息关联层 (app/post_file_change.go)                    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Post.FileIds ↔ FileInfo.PostId 双向关联                                  │  │
│  │  processPostFileChanges: 创建/更新帖子时处理文件关联                      │  │
│  │  普通上传和分片上传统一输出 FileInfo，收敛到同一消息关联机制              │  │
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

## 2.2 分片上传深度剖析

### 2.2.1 UploadSession 数据模型

**核心模型定义** (`server/public/model/upload_session.go`):

```go
type UploadSession struct {
    Id          string       `json:"id"`           // 会话唯一标识
    Type        UploadType   `json:"type"`         // 类型: attachment 或 import
    CreateAt    int64        `json:"create_at"`    // 创建时间戳
    UserId      string       `json:"user_id"`      // 上传用户 ID
    ChannelId   string       `json:"channel_id,omitempty"` // 目标频道 (仅 attachment)
    Filename    string       `json:"filename"`     // 文件名
    Path        string       `json:"-"`            // 存储路径 (不序列化到客户端)
    FileSize    int64        `json:"file_size"`    // 预期总大小
    FileOffset  int64        `json:"file_offset"`  // 已接收字节数 (进度指针)
    RemoteId    string       `json:"remote_id"`    // 共享频道远程标识
    ReqFileId   string       `json:"req_file_id"`  // 共享频道请求文件ID
}
```

**UploadType 枚举**:
```go
const (
    UploadTypeAttachment   UploadType = "attachment"  // 消息附件
    UploadTypeImport       UploadType = "import"      // 数据导入
    IncompleteUploadSuffix            = ".tmp"         // 未完成文件后缀
)
```

**状态判断规则**:
```go
// 上传未完成: FileOffset < FileSize
// 上传已完成: FileOffset == FileSize
if us.FileOffset != us.FileSize {
    // 返回 nil 表示上传未完成，客户端继续上传
    return nil, nil
}
```

### 2.2.2 会话状态管理详解

**状态机流转**:

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    状态流转图                             │
                    └─────────────────────────────────────────────────────────┘

  ┌─────────────┐       ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
  │   CREATED   │──────▶│  UPLOADING  │──────▶│  RESUMABLE  │──────▶│  COMPLETED  │
  │ FileOffset=0│       │  首片写入   │       │  断点续传   │       │ 生成FileInfo│
  │ 存入数据库  │       │  ≥5MB或全量 │       │  AppendFile │       │ 删除Session │
  └─────────────┘       └─────────────┘       └─────────────┘       └─────────────┘
         │                      │                      │                      │
         │                      │                      │                      │
         ▼                      ▼                      ▼                      ▼
  ┌─────────────┐       ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
  │ POST /uploads│       │ POST /uploads│       │ GET /uploads │      │POST /uploads│
  │  创建会话    │       │  /{id} (首片)│       │  /{id} 查询  │      │ /{id} (末片)│
  └─────────────┘       └─────────────┘       └─────────────┘       └─────────────┘
```

**双重并发控制机制** (`server/channels/app/upload.go:197-227`):

```go
func (a *App) UploadData(rctx request.CTX, us *model.UploadSession, rd io.Reader) (*model.FileInfo, *model.AppError) {
    // ==================== 第一层: 内存级互斥锁 ====================
    a.ch.uploadLockMapMut.Lock()
    locked := a.ch.uploadLockMap[us.Id]
    if locked {
        // 同一 session 已有上传在进行，直接返回并发错误
        a.ch.uploadLockMapMut.Unlock()
        return nil, model.NewAppError("UploadData", 
            "app.upload.upload_data.concurrent.app_error",
            nil, "", http.StatusBadRequest)
    }
    a.ch.uploadLockMap[us.Id] = true
    a.ch.uploadLockMapMut.Unlock()

    // defer 在函数退出时释放锁
    defer func() {
        a.ch.uploadLockMapMut.Lock()
        delete(a.ch.uploadLockMap, us.Id)  // 从映射中移除，而不是设为 false
        a.ch.uploadLockMapMut.Unlock()
    }()

    // ==================== 第二层: 数据库级一致性校验 ====================
    // 强制从主库读取，防止读从库导致的延迟问题
    rctx = rctx.With(RequestContextWithMaster)
    
    storedSession, err := a.GetUploadSession(rctx, us.Id)
    if err != nil {
        return nil, err
    }
    
    // 关键校验: 客户端传来的 FileOffset 必须与数据库一致
    if us.FileOffset != storedSession.FileOffset {
        return nil, model.NewAppError("UploadData", 
            "app.upload.upload_data.concurrent.app_error",
            nil, "FileOffset mismatch", http.StatusBadRequest)
    }
    // ...
}
```

**设计意图**:
1. **内存锁**: 防止同一进程内的并发请求（如客户端快速重试）
2. **数据库校验**: 防止跨进程/跨服务器的并发问题（如负载均衡环境）
3. **主库读取**: `RequestContextWithMaster` 确保读取最新状态

### 2.2.3 状态推进机制详解

**核心推进逻辑** (`server/channels/app/upload.go:228-281`):

```go
// 限制读取字节数，防止超出预期大小
lr := &io.LimitedReader{
    R: rd,
    N: us.FileSize - us.FileOffset,  // 只允许读取剩余字节
}

var written int64
var err *model.AppError

if us.FileOffset == 0 {
    // ==================== 状态 1: 新上传 (首片) ====================
    written, err = a.WriteFile(lr, uploadPath)
    
    // 首片特殊规则: 必须 >=5MB 或完整文件
    if written < minFirstPartSize && written != us.FileSize {
        // 删除已写入的数据，保持状态一致性
        if fileErr := a.RemoveFile(uploadPath); fileErr != nil {
            rctx.Logger().Warn("Failed to remove initial upload chunk that was too small",
                mlog.String("upload_path", uploadPath),
                mlog.Int("chunk_size", int(written)),
                mlog.Int("min_size", minFirstPartSize))  // 5MB
        }
        return nil, model.NewAppError("UploadData", 
            "app.upload.upload_data.first_part_too_small.app_error",
            map[string]any{"Size": minFirstPartSize}, "", http.StatusBadRequest)
    }
} else if us.FileOffset < us.FileSize {
    // ==================== 状态 2: 续传 (后续分片) ====================
    // 使用 AppendFile 追加到现有文件末尾
    written, err = a.AppendFile(lr, uploadPath)
}

// ==================== 状态推进: 更新 FileOffset ====================
if written > 0 {
    us.FileOffset += written  // 推进进度指针
    
    // 持久化到数据库
    if storeErr := a.Srv().Store().UploadSession().Update(us); storeErr != nil {
        return nil, model.NewAppError("UploadData", 
            "app.upload.upload_data.update.app_error", 
            nil, "", http.StatusInternalServerError).Wrap(storeErr)
    }
}

// 写入过程中出错，返回错误 (FileOffset 已更新 if written > 0)
if err != nil {
    return nil, err
}

// ==================== 状态 3: 上传未完成 ====================
if us.FileOffset != us.FileSize {
    // 返回 (nil, nil) 表示"未完成，继续上传"
    // 客户端可以继续 POST 数据或 GET 查询进度
    return nil, nil
}
```

**存储后端支持续传的差异**:

| 存储后端 | WriteFile 实现 | AppendFile 实现 |
|----------|----------------|-----------------|
| **LocalFileBackend** | `os.O_CREATE \| os.O_TRUNC` | `os.O_APPEND` |
| **S3FileBackend** | minio.PutObject | 依赖 S3 Multipart Upload |

**LocalFileBackend 实现** (`server/platform/shared/filestore/localstore.go`):

```go
// 新建文件
func (b *LocalFileBackend) WriteFile(fr io.Reader, path string) (int64, error) {
    // O_CREATE: 不存在则创建
    // O_TRUNC: 存在则截断为0
    fw, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
    // ...
    written, err := io.Copy(fw, fr)
    return written, err
}

// 追加文件
func (b *LocalFileBackend) AppendFile(fr io.Reader, path string) (int64, error) {
    // O_APPEND: 写入时自动定位到文件末尾
    fw, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
    // ...
    written, err := io.Copy(fw, fr)
    return written, err
}
```

### 2.2.4 断点续传实现机制

**断点续传的完整交互流程**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        断点续传交互时序图                                       │
└─────────────────────────────────────────────────────────────────────────────┘

  客户端                              服务端                              存储
    │                                   │                                  │
    │  1. POST /api/v4/uploads          │                                  │
    │  {filename:"large.zip",           │                                  │
    │   file_size:209715200,            │                                  │
    │   channel_id:"...", type:"attachment"} │                              │
    │──────────────────────────────────▶│                                  │
    │                                   │  创建 UploadSession:              │
    │                                   │  - FileOffset = 0                 │
    │                                   │  - FileSize = 200MB              │
    │                                   │  - 存入 UploadSessions 表        │
    │                                   │─────────────────────────────────▶│
    │                                   │◀─────────────────────────────────│
    │◀──────────────────────────────────│                                  │
    │  201 Created                      │                                  │
    │  {id:"upload_123",                │                                  │
    │   file_offset:0}                   │                                  │
    │                                   │                                  │
    │  2. POST /api/v4/uploads/upload_123│                                  │
    │  Body: 第1片数据 (60MB)            │                                  │
    │  Content-Range: bytes=0-62914559  │                                  │
    │──────────────────────────────────▶│                                  │
    │                                   │  校验:                            │
    │                                   │  - 内存锁: uploadLockMap["upload_123"]=true │
    │                                   │  - 数据库: FileOffset 应为 0      │
    │                                   │                                  │
    │                                   │  写入:                            │
    │                                   │  WriteFile(..., path)            │
    │                                   │─────────────────────────────────▶│
    │                                   │◀─────────────────────────────────│
    │                                   │  60MB 写入成功                    │
    │                                   │                                  │
    │                                   │  更新数据库:                       │
    │                                   │  FileOffset = 0 + 62914560      │
    │                                   │─────────────────────────────────▶│
    │                                   │◀─────────────────────────────────│
    │◀──────────────────────────────────│                                  │
    │  200 OK                           │                                  │
    │  {id:"upload_123",                │                                  │
    │   file_offset:62914560}           │  (返回 nil, nil 表示未完成)      │
    │                                   │                                  │
    │  3. POST /api/v4/uploads/upload_123│                                  │
    │  Body: 第2片数据 (70MB)            │                                  │
    │  【网络中断！】                     │                                  │
    │──────────────X                     │                                  │
    │                                   │                                  │
    │  【重试前查询状态】                 │                                  │
    │  4. GET /api/v4/uploads/upload_123 │                                  │
    │──────────────────────────────────▶│                                  │
    │                                   │  从数据库查询:                     │
    │                                   │  SELECT * FROM UploadSessions     │
    │                                   │  WHERE Id = 'upload_123'         │
    │                                   │─────────────────────────────────▶│
    │                                   │◀─────────────────────────────────│
    │◀──────────────────────────────────│                                  │
    │  200 OK                           │                                  │
    │  {id:"upload_123",                │                                  │
    │   file_offset:62914560}           │  ← 权威进度，从这里继续          │
    │                                   │                                  │
    │  5. POST /api/v4/uploads/upload_123│                                  │
    │  Body: 第2片数据 (70MB)            │                                  │
    │  【携带 file_offset=62914560】     │                                  │
    │──────────────────────────────────▶│                                  │
    │                                   │  校验:                            │
    │                                   │  - 数据库 FileOffset = 62914560   │
    │                                   │  - 与客户端一致 ✓                   │
    │                                   │                                  │
    │                                   │  追加写入:                         │
    │                                   │  AppendFile(..., path)            │
    │                                   │─────────────────────────────────▶│
    │                                   │◀─────────────────────────────────│
    │                                   │  FileOffset = 62914560 + 73400320│
    │                                   │  = 136314880 (130MB)              │
    │                                   │                                  │
    │◀──────────────────────────────────│                                  │
    │  200 OK                           │                                  │
    │  {id:"upload_123",                │                                  │
    │   file_offset:136314880}          │                                  │
    │                                   │                                  │
    │  6. POST /api/v4/uploads/upload_123│                                  │
    │  Body: 第3片数据 (70MB)            │                                  │
    │  【最后一片，完成上传】              │                                  │
    │──────────────────────────────────▶│                                  │
    │                                   │  1. AppendFile 追加 70MB          │
    │                                   │  2. FileOffset = 136314880 + 73400320│
    │                                   │     = 209715200 (200MB)          │
    │                                   │  3. FileOffset == FileSize ✓      │
    │                                   │                                  │
    │                                   │  【完成后处理】                     │
    │                                   │  1. 读取文件生成 FileInfo          │
    │                                   │  2. 图片预处理/后处理               │
    │                                   │  3. 保存 FileInfo 到数据库         │
    │                                   │  4. 删除 UploadSession             │
    │                                   │─────────────────────────────────▶│
    │                                   │◀─────────────────────────────────│
    │◀──────────────────────────────────│                                  │
    │  201 Created                      │                                  │
    │  {id:"file_456",                  │  ← 返回 FileInfo，上传完成         │
    │   name:"large.zip",               │                                  │
    │   size:209715200}                 │                                  │
```

**API 层 - 会话状态查询** (`server/channels/api4/upload.go:68-101`):

```go
func getUpload(c *Context, w http.ResponseWriter, r *http.Request) {
    // 从 URL 获取 upload_id
    uploadID := c.Params.UploadId
    
    // 查询数据库获取当前状态
    us, err := c.App.GetUploadSession(c.AppContext, uploadID)
    if err != nil {
        c.Err = err
        return
    }
    
    // 权限校验: 只能是会话所有者或系统管理员
    if us.UserId != c.AppContext.Session().UserId && 
       !c.App.SessionHasPermissionTo(*c.AppContext.Session(), 
                                     model.PermissionManageSystem) {
        c.SetPermissionError(model.PermissionManageSystem)
        return
    }
    
    // 返回会话状态，客户端据此知道从哪里继续
    if err = json.NewEncoder(w).Encode(us); err != nil {
        c.Logger().Warn("Error while encoding response", mlog.Err(err))
        return
    }
}
```

### 2.2.5 失败重试与错误处理

**错误类型与恢复策略汇总**:

| 错误场景 | 错误码 | 服务端处理 | 客户端处理 |
|----------|--------|------------|------------|
| 并发上传冲突 | 400 Bad Request | 内存锁或 FileOffset 不匹配 | 等待后重试，或先 GET 查询进度 |
| 首片大小不足 5MB | 400 Bad Request | 删除已写数据，FileOffset 不变 | 使用更大的分片重新上传 |
| 会话不存在 | 404 Not Found | 返回 ErrNotFound | 重新创建会话从头开始 |
| 网络中断 (写入中) | 连接超时 | FileOffset 可能已推进 (if written > 0) | GET 查询进度后从新 offset 继续 |
| 数据库更新失败 | 500 Internal Error | 写入可能已成功但状态未持久化 | GET 查询主库获取权威状态 |
| 存储后端错误 | 500 Internal Error | 视情况而定 | 重试或检查配置 |

**关键代码分析 - 写入失败的处理** (`server/channels/app/upload.go:264-276`):

```go
// 注意这个顺序: 先推进状态，再检查错误
if written > 0 {
    // 只要写入了数据，就推进 FileOffset
    us.FileOffset += written
    
    // 持久化到数据库
    if storeErr := a.Srv().Store().UploadSession().Update(us); storeErr != nil {
        // 数据库更新失败，但文件可能已写入
        // 这种情况下可能出现状态不一致
        return nil, model.NewAppError("UploadData", 
            "app.upload.upload_data.update.app_error", 
            nil, "", http.StatusInternalServerError).Wrap(storeErr)
    }
}

// 检查写入过程中是否有错误
if err != nil {
    // 如果 written > 0，FileOffset 已经被更新并持久化
    // 下次上传将从新的 offset 继续
    return nil, err
}
```

**设计特点**:
1. **At-Least-Once 语义**: 即使部分写入也推进状态，避免重复写入已成功的数据
2. **幂等性依赖**: 客户端需要先 GET 查询进度，不能假设上次发送了多少
3. **主库读取**: `RequestContextWithMaster` 确保读取最新状态

**客户端重试策略示例** (伪代码):

```javascript
async function uploadFileWithResumable(file, channelId) {
    // 1. 创建会话
    let session = await client.createUpload({
        filename: file.name,
        file_size: file.size,
        channel_id: channelId,
        type: 'attachment'
    });
    
    let fileInfo = null;
    let offset = 0;
    const chunkSize = 8 * 1024 * 1024; // 8MB 分片
    
    while (offset < file.size) {
        try {
            const chunk = file.slice(offset, offset + chunkSize);
            
            // 2. 上传分片 (携带当前 offset)
            fileInfo = await client.uploadData(session.id, chunk, offset);
            
            if (fileInfo) {
                // 返回了 FileInfo，上传完成
                break;
            }
            
            // 未完成，推进 offset
            // 注意: 实际上应该从响应或重新查询获取新的 offset
            offset += chunk.size;
            
        } catch (error) {
            // 3. 失败时查询权威状态
            console.warn('Upload chunk failed, querying state...', error);
            
            // 关键: 从服务端获取真正的进度
            session = await client.getUpload(session.id);
            offset = session.file_offset;
            
            // 等待后重试
            await sleep(1000);
        }
    }
    
    return fileInfo;
}
```

---

## 2.3 上传完成 - 收敛到 FileInfo

### 2.3.1 分片上传的完成逻辑

**上传完成时的处理** (`server/channels/app/upload.go:282-364`):

```go
// 上传完成的条件: FileOffset == FileSize
if us.FileOffset != us.FileSize {
    return nil, nil  // 未完成，继续上传
}

// ==================== 上传完成，开始收敛 ====================

// 1. 读取已上传的完整文件
file, err := a.FileReader(uploadPath)
if err != nil {
    return nil, model.NewAppError("UploadData", 
        "app.upload.upload_data.read_file.app_error", 
        nil, "", http.StatusInternalServerError).Wrap(err)
}

// 2. 生成 FileInfo (与普通上传完全相同的结构)
info, genErr := a.genFileInfoFromReader(us.Filename, file, us.FileSize)
file.Close()
if genErr != nil {
    // ... 错误处理
}

// 3. 填充元数据
info.CreatorId = us.UserId
info.ChannelId = us.ChannelId
info.Path = us.Path  // 存储路径
info.RemoteId = model.NewPointer(us.RemoteId)

// 4. 运行插件钩子 (与普通上传相同)
if err := a.runPluginsHook(rctx, info, file); err != nil {
    return nil, err
}

// 5. 图片后处理 - 生成 thumbnail/preview/mini_preview
if info.IsImage() && !info.IsSvg() {
    // 分辨率检查
    if limitErr := checkImageResolutionLimit(info.Width, info.Height, 
        *a.Config().FileSettings.MaxImageResolution); limitErr != nil {
        return nil, model.NewAppError("uploadData", 
            "app.upload.upload_data.large_image.app_error",
            map[string]any{"Filename": us.Filename, 
                          "Width": info.Width, 
                          "Height": info.Height}, 
            "", http.StatusBadRequest)
    }

    // 设置衍生文件路径
    nameWithoutExtension := info.Name[:strings.LastIndex(info.Name, ".")]
    info.PreviewPath = filepath.Dir(info.Path) + "/" + 
                       nameWithoutExtension + "_preview." + 
                       getFileExtFromMimeType(info.MimeType)
    info.ThumbnailPath = filepath.Dir(info.Path) + "/" + 
                         nameWithoutExtension + "_thumb." + 
                         getFileExtFromMimeType(info.MimeType)

    // 读取文件数据进行处理
    imgData, fileErr := a.ReadFile(uploadPath)
    if fileErr != nil {
        return nil, fileErr
    }
    
    // 生成缩略图和预览图
    a.HandleImages(rctx, 
        []string{info.PreviewPath}, 
        []string{info.ThumbnailPath}, 
        [][]byte{imgData})
}

// 6. Import 类型特殊处理: 重命名去掉 .tmp 后缀
if us.Type == model.UploadTypeImport {
    if err := a.MoveFile(uploadPath, us.Path); err != nil {
        return nil, model.NewAppError("UploadData", 
            "app.upload.upload_data.move_file.app_error", 
            nil, "", http.StatusInternalServerError).Wrap(err)
    }
}

// 7. 保存 FileInfo 到数据库 (收敛的关键一步)
var storeErr error
if info, storeErr = a.Srv().Store().FileInfo().Save(rctx, info); storeErr != nil {
    // ... 错误处理
}

// 8. 异步提取内容 (用于全文搜索)
if *a.Config().FileSettings.ExtractContent {
    infoCopy := *info
    a.Srv().Go(func() {
        err := a.ExtractContentFromFileInfo(rctx, &infoCopy)
        if err != nil {
            rctx.Logger().Error("Failed to extract file content", 
                mlog.Err(err), mlog.String("fileInfoId", infoCopy.Id))
        }
    })
}

// 9. 删除 UploadSession (清理临时状态)
if storeErr := a.Srv().Store().UploadSession().Delete(us.Id); storeErr != nil {
    rctx.Logger().Warn("Failed to delete UploadSession", mlog.Err(storeErr))
}

// 10. 返回 FileInfo (与普通上传完全相同的输出)
return info, nil
```

### 2.3.2 两种上传方式的统一收敛

**收敛点对比**:

| 阶段 | 普通上传 (POST /files) | 分片上传 (POST /uploads) |
|------|------------------------|--------------------------|
| **输入** | multipart/form-data | JSON 创建会话 + 多次数据块 |
| **中间状态** | 无中间状态 | UploadSession (FileOffset 追踪) |
| **存储写入** | 一次 `WriteFile` | 多次 `WriteFile` + `AppendFile` |
| **收敛点** | `UploadFileX()` 返回 `FileInfo` | `UploadData()` 返回 `FileInfo` |
| **输出** | `FileInfo` (PostId = "") | `FileInfo` (PostId = "") |
| **后续处理** | 消息关联 (相同流程) | 消息关联 (相同流程) |

**统一的数据结构 - FileInfo**:

```go
type FileInfo struct {
    // 标识
    Id              string     `json:"id"`           // 文件唯一标识
    CreatorId       string     `json:"creator_id"`   // 上传用户
    PostId          string     `json:"post_id"`      // 关联的消息 ID (初始为空)
    ChannelId       string     `json:"channel_id"`   // 目标频道
    
    // 元数据
    Name            string     `json:"name"`
    Extension       string     `json:"extension"`
    MimeType        string     `json:"mime_type"`
    Size            int64      `json:"size"`
    
    // 图片特有
    Width           int        `json:"width"`
    Height          int        `json:"height"`
    HasPreviewImage bool       `json:"has_preview_image"`
    
    // 存储路径
    Path            string     `json:"-"`
    PreviewPath     string     `json:"-"`
    ThumbnailPath   string     `json:"-"`
    
    // 内嵌预览
    MiniPreview     *[]byte    `json:"mini_preview"`
}
```

### 2.3.3 从上传完成到消息展示的完整收敛流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    两种上传方式的统一收敛流程                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌───────────────────────┐                    ┌───────────────────────┐
  │    普通上传路径        │                    │    分片上传路径        │
  └───────────────────────┘                    └───────────────────────┘
              │                                              │
              ▼                                              ▼
  ┌───────────────────────┐                    ┌───────────────────────┐
  │  POST /api/v4/files   │                    │  1. POST /uploads     │
  │  multipart/form-data  │                    │  创建 UploadSession   │
  └───────────────────────┘                    └───────────────────────┘
              │                                              │
              ▼                                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        服务端处理层 (app/)                            │
  │  ┌───────────────────────┐                    ┌─────────────────────┐│
  │  │   UploadFileX()       │                    │  CreateUploadSession ││
  │  │  - 权限校验            │                    │  UploadData()        ││
  │  │  - 解析 multipart     │                    │  - 并发控制          ││
  │  │  - 写入存储            │                    │  - FileOffset 推进   ││
  │  │  - 图片预处理/后处理   │                    │  - 循环直到完成      ││
  │  │  - 插件钩子            │                    └──────────┬──────────┘│
  │  └──────────┬────────────┘                               │           │
  │             │                                            │           │
  │             ▼                                            ▼           │
  │  ┌─────────────────────────────────────────────────────────────────┐ │
  │  │                    收敛点: 生成 FileInfo                          │ │
  │  │  - 两种方式都调用 genFileInfoFromReader()                         │ │
  │  │  - 都保存到 FileInfo 表 (PostId = "")                            │ │
  │  │  - 都返回相同结构的 FileInfo 给客户端                              │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────────┘
              │                                              │
              └──────────────────┬───────────────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │   客户端获得 FileInfo   │
                    │   {id: "file_abc",     │
                    │    name: "report.pdf", │
                    │    size: 1048576,      │
                    │    post_id: ""}         │
                    └────────────┬───────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   发送消息              │
                    │   POST /api/v4/posts   │
                    │   {                    │
                    │     channel_id: "...", │
                    │     message: "查看文件",│
                    │     file_ids: ["file_abc"] ← 关键: 引用 file_id
                    │   }                    │
                    └────────────┬───────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────────────────┐
                    │    消息关联层 (统一处理，与上传方式无关)  │
                    └─────────────────────────────────────────┘
                    │                                         │
                    ▼                                         │
          ┌───────────────────────┐                           │
          │  processPostFileChanges│                          │
          │  - 计算差异            │                          │
          │    addedFileIDs,      │                          │
          │    removedFileIDs     │                          │
          └───────────┬───────────┘                          │
                      │                                      │
                      ▼                                      │
          ┌───────────────────────┐                           │
          │  attachFileIDsToPost  │                          │
          │  验证条件:             │                          │
          │  1. FileInfo.PostId==""│                         │
          │  2. CreatorId 匹配    │                          │
          │  3. ChannelId 匹配    │                          │
          └───────────┬───────────┘                          │
                      │                                      │
                      ▼                                      │
          ┌───────────────────────┐                           │
          │  更新数据库:           │                          │
          │  FileInfo.PostId =    │                          │
          │    post.Id             │                          │
          └───────────┬───────────┘                          │
                      │                                      │
                      └──────────────────┬───────────────────┘
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │         消息展示层 (统一渲染)            │
                    └─────────────────────────────────────────┘
                    │                                         │
                    ▼                                         │
          ┌───────────────────────┐                           │
          │  客户端获取帖子列表    │                          │
          │  GET /api/v4/posts    │                          │
          └───────────┬───────────┘                          │
                      │                                      │
                      ▼                                      │
          ┌───────────────────────┐                           │
          │  服务端查询:           │                          │
          │  1. Post 表获取基础信息│                         │
          │  2. FileInfo 表通过   │                          │
          │     PostId 关联查询   │                          │
          │     (支持缓存)         │                          │
          └───────────┬───────────┘                          │
                      │                                      │
                      ▼                                      │
          ┌───────────────────────┐                           │
          │  客户端渲染:           │                          │
          │  - 遍历 Post.FileIds  │                          │
          │  - 根据 MIME 类型显示 │                          │
          │    图片: 缩略图        │                          │
          │    其他: 图标+名称     │                          │
          └───────────────────────┘                           │
```

### 2.3.4 消息关联的核心代码

**两种上传方式最终都经过相同的消息关联流程**:

```go
// server/channels/app/post_file_change.go:12-43
func (a *App) processPostFileChanges(rctx request.CTX, 
    newPost, oldPost *model.Post, 
    updatePostOptions *model.UpdatePostOptions) (model.StringArray, *model.AppError) {
    
    // 去重 (不关心文件来自哪种上传方式)
    newFileIDs := model.RemoveDuplicateStrings(newPost.FileIds)
    oldFileIDs := model.RemoveDuplicateStrings(oldPost.FileIds)
    
    // 计算差异 (只关心 file_id，不关心上传方式)
    addedFileIDs, removedFileIDs, unchangedFileIDs := 
        utils.FindExclusives(newFileIDs, oldFileIDs)

    // 处理新增文件 (统一验证和关联)
    if len(addedFileIDs) > 0 {
        // 验证条件:
        // 1. FileInfo 存在
        // 2. FileInfo.PostId == "" (未关联到其他消息)
        // 3. FileInfo.CreatorId 匹配当前用户
        // 4. FileInfo.ChannelId 匹配
        a.attachNewFilesToPost(rctx, newPost, addedFileIDs, unchangedFileIDs)
    }

    // 处理删除文件
    if len(removedFileIDs) > 0 {
        a.detachFilesFromPost(rctx, newPost.Id, removedFileIDs)
    }

    // 缓存失效
    if len(addedFileIDs) > 0 || len(removedFileIDs) > 0 {
        a.Srv().Store().FileInfo().InvalidateFileInfosForPostCache(newPost.Id, false)
    }

    return newPost.FileIds, nil
}
```

**attachFileIDsToPost 中的验证逻辑** (统一适用于所有 FileInfo):

```go
// server/channels/app/file.go 中的实现
func (a *App) attachFileIDsToPost(rctx request.CTX, 
    postId, channelId, userId string, 
    fileIDs []string) []string {
    
    var attachedFileIDs []string
    
    for _, fileID := range fileIDs {
        // 关键查询: 通过 FileInfoStore 获取
        // 不区分是普通上传还是分片上传生成的
        fileInfo, err := a.Srv().Store().FileInfo().GetForUser(
            fileID,      // 文件 ID
            userId,      // 上传用户
            channelId)   // 目标频道
        
        if err != nil {
            rctx.Logger().Warn("Unable to attach file to post", 
                mlog.String("file_id", fileID), mlog.Err(err))
            continue
        }
        
        // 验证未关联到其他消息
        if fileInfo.PostId != "" {
            rctx.Logger().Warn("File already attached to another post", 
                mlog.String("file_id", fileID))
            continue
        }
        
        // 关联: 更新 FileInfo.PostId
        err = a.Srv().Store().FileInfo().AttachToPost(
            fileID,   // 文件 ID
            postId,   // 消息 ID
            userId)   // 用户 ID (验证)
        
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

---

## 2.4 客户端调用链与服务端状态协同

### 2.4.1 普通上传的完整客户端调用链

**Webapp 端当前实现** (基于实际代码分析):

目前 Mattermost Webapp 只实现了普通上传 (`POST /api/v4/files`)，分片上传 API 存在于服务端但 Webapp 尚未使用（为桌面/移动应用预留）。

**调用链流程图**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    普通上传 - 完整客户端调用链                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  用户交互层 (UI Components)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  FileUpload 组件                                                            │
  │  ├── 拖放文件 (handleDrop)                                                  │
  │  ├── 粘贴图片 (pasteUpload)                                                 │
  │  ├── 快捷键上传 (keyUpload: Ctrl/Cmd + U)                                  │
  │  └── 按钮选择 (simulateInputClick)                                          │
  │                                                                              │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │                    use_upload_files.tsx (Hook)                        │  │
  │  │  ├── handleUploadStart: clientIds 加入 uploadsInProgress             │  │
  │  │  ├── handleUploadProgress: 更新进度百分比                              │  │
  │  │  ├── handleFileUploadComplete: 更新 draft.fileInfos                   │  │
  │  │  └── handleUploadError: 错误处理，移除上传中状态                       │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  Redux Action 层
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  file_actions.ts: uploadFile()                                             │
  │  ├── 1. dispatch({type: UPLOAD_FILES_REQUEST})                            │
  │  ├── 2. 创建 XMLHttpRequest                                                │
  │  ├── 3. 设置请求头 (Authorization, Accept: application/json)              │
  │  ├── 4. 构建 FormData:                                                    │
  │  │       ├── channel_id                                                    │
  │  │       ├── client_ids (客户端生成的临时 ID)                              │
  │  │       └── files (文件内容，放在最后以支持流式上传)                      │
  │  ├── 5. 注册回调:                                                          │
  │  │       ├── xhr.upload.onprogress: 进度更新                              │
  │  │       ├── xhr.onload: 响应处理                                          │
  │  │       └── xhr.onerror: 错误处理                                         │
  │  └── 6. xhr.send(formData)                                                 │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  网络传输层
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  POST /api/v4/files                                                         │
  │  Content-Type: multipart/form-data; boundary=...                          │
  │                                                                              │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  请求体 (multipart/form-data):                                          │  │
  │  │  ├── Content-Disposition: form-data; name="channel_id"                │  │
  │  │  │   "abc123" (目标频道 ID)                                            │  │
  │  │  ├── Content-Disposition: form-data; name="client_ids"                │  │
  │  │  │   "client_xyz" (客户端生成的临时 ID)                                 │  │
  │  │  └── Content-Disposition: form-data; name="files"; filename="photo.jpg"│  │
  │  │      Content-Type: image/jpeg                                          │  │
  │  │      [文件二进制数据]                                                   │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  响应处理
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  成功响应 (HTTP 201 Created):                                               │
  │  {                                                                          │
  │    "file_infos": [                                                          │
  │      {                                                                       │
  │        "id": "file_abc123",         ← 服务端生成的 file_id                │
  │        "name": "photo.jpg",                                                 │
  │        "size": 1048576,                                                     │
  │        "mime_type": "image/jpeg",                                           │
  │        "post_id": "",                 ← 暂未关联消息                        │
  │        ...                                                                   │
  │      }                                                                       │
  │    ],                                                                       │
  │    "client_ids": ["client_xyz"]      ← 对应客户端传入的 client_id         │
  │  }                                                                          │
  │                                                                              │
  │  后续:                                                                       │
  │  ├── dispatch(RECEIVED_UPLOAD_FILES) → 保存到 Redux store                 │
  │  ├── draft.uploadsInProgress → draft.fileInfos (状态转换)                  │
  │  └── 等待用户发送消息时关联到 Post                                          │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
```

**核心代码分析** (`webapp/channels/src/actions/file_actions.ts:32-155`):

```typescript
export function uploadFile({
    file, name, type, rootId, channelId, clientId,
    onProgress, onSuccess, onError
}: UploadFile, isBookmark?: boolean): ThunkActionFunc<XMLHttpRequest> {
    return (dispatch, getState) => {
        // 1. 发起请求 Action
        dispatch({type: FileTypes.UPLOAD_FILES_REQUEST});

        // 2. 构建 URL
        let url = Client4.getFilesRoute();
        if (isBookmark) {
            url += '?bookmark=true';
        }

        // 3. 创建 XMLHttpRequest (不使用 fetch 以便支持进度回调)
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);

        // 4. 设置认证头
        const client4Headers = Client4.getOptions({method: 'POST'}).headers;
        Object.keys(client4Headers).forEach((client4Header) => {
            const client4HeaderValue = client4Headers[client4Header];
            if (client4HeaderValue) {
                xhr.setRequestHeader(client4Header, client4HeaderValue);
            }
        });
        xhr.setRequestHeader('Accept', 'application/json');

        // 5. 构建 FormData
        const formData = new FormData();
        formData.append('channel_id', channelId);
        formData.append('client_ids', clientId);
        formData.append('files', file, name); // 文件放在最后以支持流式上传

        // 6. 进度回调
        if (onProgress && xhr.upload) {
            xhr.upload.onprogress = (event) => {
                const percent = Math.floor((event.loaded / event.total) * 100);
                const filePreviewInfo = {
                    clientId, name, percent, type
                } as FilePreviewInfo;
                onProgress(filePreviewInfo);
            };
        }

        // 7. 成功回调
        if (onSuccess) {
            xhr.onload = () => {
                if (xhr.status === 201 && xhr.readyState === 4) {
                    const response = JSON.parse(xhr.response);
                    // 映射 file_id 和 client_id
                    const data = response.file_infos.map((fileInfo: FileInfo, index: number) => {
                        return {
                            ...fileInfo,
                            clientId: response.client_ids[index],
                        };
                    });

                    dispatch(batchActions([
                        {
                            type: FileTypes.RECEIVED_UPLOAD_FILES,
                            data,
                            channelId,
                            rootId,
                        },
                        {
                            type: FileTypes.UPLOAD_FILES_SUCCESS,
                        },
                    ]));

                    onSuccess(response, channelId, rootId);
                } else if (xhr.status >= 400 && xhr.readyState === 4) {
                    // HTTP 错误处理
                    dispatch({
                        type: FileTypes.UPLOAD_FILES_FAILURE,
                        clientIds: [clientId],
                        channelId,
                        rootId,
                    });
                    onError?.(errorMessage, clientId, channelId, rootId);
                }
            };
        }

        // 8. 网络错误回调
        if (onError) {
            xhr.onerror = () => {
                if (xhr.readyState === 4 && xhr.responseText.length !== 0) {
                    // 有响应内容的错误
                    const errorResponse = JSON.parse(xhr.response);
                    forceLogoutIfNecessary(errorResponse, dispatch, getState);
                    onError(errorResponse, clientId, channelId, rootId);
                } else {
                    // 网络中断或超时
                    const errorMessage = xhr.status === 0 || !xhr.status 
                        ? 'There was a problem uploading your files.'
                        : 'Unexpected status code: ' + xhr.status;
                    dispatch({
                        type: FileTypes.UPLOAD_FILES_FAILURE,
                        clientIds: [clientId],
                        channelId,
                        rootId,
                    });
                    onError({message: errorMessage}, clientId, channelId, rootId);
                }
            };
        }

        // 9. 发送请求
        xhr.send(formData);

        return xhr;
    };
}
```

### 2.4.2 分片上传的理想客户端调用链 (基于服务端 API 设计)

虽然 Webapp 尚未实现分片上传，但服务端 API 已完整设计。以下是基于服务端测试代码分析的理想客户端实现：

**API 端点回顾**:

| 端点 | 方法 | 请求体 | 响应 | 说明 |
|------|------|--------|------|------|
| `/api/v4/uploads` | POST | `{filename, file_size, channel_id, type}` | UploadSession | 创建上传会话 |
| `/api/v4/uploads/{id}` | GET | 无 | UploadSession | 获取会话状态（权威进度） |
| `/api/v4/uploads/{id}` | POST | 二进制数据或 multipart | 204 No Content 或 FileInfo | 上传数据块 |

**完整调用链流程图**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    分片上传 - 理想客户端调用链                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  客户端状态机
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐       │
  │  │  IDLE    │────▶│ CREATING │────▶│ UPLOADING│────▶│ COMPLETED│       │
  │  │          │     │          │     │          │     │          │       │
  │  └──────────┘     └──────────┘     └────┬─────┘     └──────────┘       │
  │                                          │                                   │
  │                                          ▼                                   │
  │                                    ┌──────────┐                            │
  │                                    │  FAILED  │                            │
  │                                    │          │                            │
  │                                    └────┬─────┘                            │
  │                                         │                                   │
  │                                         ▼                                   │
  │                                    ┌──────────┐                            │
  │                                    │ RESUMING │                            │
  │                                    │ 查询权威  │                            │
  │                                    │  进度    │                            │
  │                                    └────┬─────┘                            │
  │                                         │                                   │
  │                                         └────────────────▶ UPLOADING       │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘

                                    │
                                    ▼
  详细交互流程
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  【阶段 1: 创建会话】                                                        │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  POST /api/v4/uploads                                                   │  │
  │  │  Body: {                                                                 │  │
  │  │    "filename": "large_file.zip",                                         │  │
  │  │    "file_size": 209715200,        ← 必须预先知道总大小                │  │
  │  │    "channel_id": "abc123",                                              │  │
  │  │    "type": "attachment"           ← attachment 或 import               │  │
  │  │  }                                                                       │  │
  │  │                                                                           │  │
  │  │  Response (HTTP 201 Created):                                            │  │
  │  │  {                                                                       │  │
  │  │    "id": "upload_xyz789",         ← 会话 ID，后续都用这个             │  │
  │  │    "type": "attachment",                                                 │  │
  │  │    "create_at": 1680000000000,                                         │  │
  │  │    "user_id": "user_abc",                                                │  │
  │  │    "channel_id": "abc123",                                               │  │
  │  │    "filename": "large_file.zip",                                         │  │
  │  │    "file_size": 209715200,                                              │  │
  │  │    "file_offset": 0                ← 初始进度为 0                        │  │
  │  │    // "path" 字段不返回给客户端（内部使用）                               │  │
  │  │  }                                                                       │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  │  【阶段 2: 上传数据块】                                                      │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  POST /api/v4/uploads/upload_xyz789                                     │  │
  │  │                                                                           │  │
  │  │  支持两种请求格式:                                                        │  │
  │  │                                                                           │  │
  │  │  格式 A: 纯二进制 (推荐)                                                 │  │
  │  │  ├── Content-Type: application/octet-stream                             │  │
  │  │  └── Body: [二进制数据块]                                                │  │
  │  │                                                                           │  │
  │  │  格式 B: multipart/form-data                                             │  │
  │  │  ├── Content-Type: multipart/form-data; boundary=...                    │  │
  │  │  └── Body: 包含 name="data" 的 part                                     │  │
  │  │                                                                           │  │
  │  │  分片大小建议:                                                            │  │
  │  │  ├── 首片: >= 5MB (minFirstPartSize)，除非是完整文件                    │  │
  │  │  └── 后续片: 任意大小 (建议 8MB 或 16MB)                                │  │
  │  │                                                                           │  │
  │  │  响应:                                                                    │  │
  │  │                                                                           │  │
  │  │  情况 1: 上传未完成 (file_offset < file_size)                           │  │
  │  │  ├── HTTP Status: 204 No Content                                        │  │
  │  │  ├── Content-Length: 0                                                   │  │
  │  │  └── 含义: 数据已接收，但文件尚未完整，继续上传                          │  │
  │  │                                                                           │  │
  │  │  情况 2: 上传完成 (file_offset == file_size)                            │  │
  │  │  ├── HTTP Status: 201 Created 或 200 OK                                 │  │
  │  │  └── Body: FileInfo 对象                                                 │  │
  │  │       {                                                                   │  │
  │  │         "id": "file_abc123",       ← 现在有了 file_id                  │  │
  │  │         "name": "large_file.zip",                                        │  │
  │  │         "size": 209715200,                                              │  │
  │  │         "post_id": "",                                                    │  │
  │  │         ...                                                               │  │
  │  │       }                                                                   │  │
  │  │                                                                           │  │
  │  │  【重要】服务端不会返回更新后的 file_offset                              │  │
  │  │  客户端必须通过 GET /uploads/{id} 查询                                   │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  │  【阶段 3: 失败后获取权威进度】                                              │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  触发场景:                                                               │  │
  │  │  ├── 网络中断 (xhr.status === 0)                                        │  │
  │  │  ├── 超时 (无响应)                                                       │  │
  │  │  ├── 并发错误 (FileOffset mismatch)                                      │  │
  │  │  └── 任何需要重新同步状态的场景                                           │  │
  │  │                                                                           │  │
  │  │  GET /api/v4/uploads/upload_xyz789                                       │  │
  │  │                                                                           │  │
  │  │  响应 (HTTP 200 OK):                                                     │  │
  │  │  {                                                                       │  │
  │  │    "id": "upload_xyz789",                                                │  │
  │  │    "file_size": 209715200,                                              │  │
  │  │    "file_offset": 62914560,       ← 【权威进度】服务端实际已接收 60MB │  │
  │  │    ...                                                                   │  │
  │  │  }                                                                       │  │
  │  │                                                                           │  │
  │  │  客户端操作:                                                              │  │
  │  │  1. 比较本地记录的 offset 和服务端返回的 file_offset                     │  │
  │  │  2. 如果服务端 > 本地: 说明上次请求部分成功，从服务端进度继续           │  │
  │  │  3. 如果服务端 == 本地: 正常重试                                         │  │
  │  │  4. 从 file.slice(file_offset) 读取数据，继续上传                        │  │
  │  │                                                                           │  │
  │  │  【关键设计】服务端是单一真值源 (Single Source of Truth)                │  │
  │  │  客户端本地记录的进度仅供参考，任何时候都可能需要重新同步                 │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  │  【阶段 4: 从断点继续上传】                                                  │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  假设:                                                                   │  │
  │  │  ├── 文件总大小: 200MB (209715200 bytes)                              │  │
  │  │  ├── 上次成功写入: 60MB (服务端 file_offset = 62914560)               │  │
  │  │  ├── 分片大小: 8MB                                                      │  │
  │  │                                                                           │  │
  │  │  继续上传:                                                               │  │
  │  │  1. 计算剩余字节: 209715200 - 62914560 = 146800640 bytes             │  │
  │  │  2. 从文件切片读取: file.slice(62914560)                               │  │
  │  │  3. 分块发送剩余数据                                                     │  │
  │  │                                                                           │  │
  │  │  POST /api/v4/uploads/upload_xyz789                                      │  │
  │  │  Body: file.slice(62914560, 62914560 + 8388608)  // 第2片 8MB        │  │
  │  │                                                                           │  │
  │  │  服务端处理:                                                              │  │
  │  │  1. 获取 UploadSession: file_offset = 62914560                          │  │
  │  │  2. 使用 AppendFile 追加到文件末尾                                       │  │
  │  │  3. 更新 FileOffset: 62914560 + 8388608 = 71303168                    │  │
  │  │  4. 保存到数据库                                                          │  │
  │  │  5. 返回 204 No Content (未完成)                                         │  │
  │  │                                                                           │  │
  │  │  重复直到最后一片:                                                        │  │
  │  │  最后一片发送后，服务端:                                                  │  │
  │  │  1. FileOffset == FileSize ✓                                             │  │
  │  │  2. 生成 FileInfo (图片后处理、生成缩略图等)                             │  │
  │  │  3. 删除 UploadSession (清理临时状态)                                    │  │
  │  │  4. 返回 FileInfo                                                         │  │
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
```

### 2.4.3 服务端测试代码中的分片上传示例

从 `server/channels/api4/upload_test.go` 的测试用例可以看到完整的交互模式：

```go
// 测试: resume success (断点续传成功)
func TestUploadData(t *testing.T) {
    // ... 初始化
    
    us := &model.UploadSession{
        ChannelId: th.BasicChannel.Id,
        Filename:  "upload.zip",
        FileSize:  8 * 1024 * 1024,  // 8MB 文件
    }
    
    // 1. 创建上传会话
    u, resp, err := th.Client.CreateUpload(context.Background(), us)
    require.NoError(t, err)
    require.Equal(t, http.StatusCreated, resp.StatusCode)
    // u.FileOffset == 0
    
    // 2. 上传第一片 (5MB) - 模拟中断前的部分上传
    rd := &io.LimitedReader{
        R: bytes.NewReader(data),
        N: 5 * 1024 * 1024,  // 只传 5MB
    }
    info, resp, err := th.Client.UploadData(context.Background(), u.Id, rd)
    require.NoError(t, err)
    require.Nil(t, info)                                    // 未完成，返回 nil
    require.Equal(t, http.StatusNoContent, resp.StatusCode) // 204 No Content
    
    // 【关键点】此时服务端 FileOffset 已更新为 5MB
    // 如果客户端崩溃，重启后需要通过 GET /uploads/{id} 查询
    
    // 3. 继续上传剩余数据 (从 5MB 开始)
    // 注意: 这里不需要告诉服务端从哪里开始
    // 服务端会根据 UploadSession.FileOffset 自动追加
    info, _, err = th.Client.UploadData(
        context.Background(), 
        u.Id, 
        bytes.NewReader(data[5*1024*1024:])  // 只传剩余部分
    )
    
    // 4. 上传完成，返回 FileInfo
    require.NoError(t, err)
    require.NotEmpty(t, info)
    require.Equal(t, u.Filename, info.Name)
}
```

### 2.4.4 客户端与服务端状态协同机制

**核心设计原则**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    状态协同 - 核心设计原则                                      │
└─────────────────────────────────────────────────────────────────────────────┘

  原则 1: 服务端是单一真值源 (Single Source of Truth)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  客户端状态 (仅供参考)                    服务端状态 (权威)                  │
  │  ┌─────────────────────┐                ┌─────────────────────┐           │
  │  │ localOffset: 30MB   │                │                     │           │
  │  │                     │   任何时候      │ UploadSession:      │           │
  │  │ lastSentChunk: 3    │   可能不同步    │   FileOffset: 60MB │ ◀── 权威 │
  │  │                     │                │   FileSize: 200MB  │           │
  │  │ 【问题】网络中断后   │                │                     │           │
  │  │  不知道实际进度      │                │ 【解决方案】         │           │
  │  └─────────────────────┘                │ GET /uploads/{id}  │           │
  │                                           │ 获取权威进度       │           │
  │                                           └─────────────────────┘           │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘

  原则 2: 服务端使用双重并发控制防止状态不一致
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  POST /api/v4/uploads/{id} 时的校验流程:                                   │
  │                                                                              │
  │  1. 内存锁检查 (uploadLockMap)                                               │
  │     ┌─────────────────────────────────────────────────────────────────┐    │
  │     │ if uploadLockMap[sessionId] == true:                            │    │
  │     │     return "concurrent upload error"                            │    │
  │     │ else:                                                             │    │
  │     │     uploadLockMap[sessionId] = true                             │    │
  │     │     defer delete(uploadLockMap, sessionId)                      │    │
  │     └─────────────────────────────────────────────────────────────────┘    │
  │                                                                              │
  │  2. 数据库级一致性校验 (强制读主库)                                          │
  │     ┌─────────────────────────────────────────────────────────────────┐    │
  │     │ // 强制从主库读取，防止从库延迟                                    │    │
  │     │ rctx = rctx.With(RequestContextWithMaster)                      │    │
  │     │                                                                     │    │
  │     │ storedSession := db.GetUploadSession(sessionId)                 │    │
  │     │                                                                     │    │
  │     │ // 关键校验: 客户端认为的 offset 必须 == 服务端实际 offset         │    │
  │     │ if clientSession.FileOffset != storedSession.FileOffset {       │    │
  │     │     return "FileOffset mismatch"                                 │    │
  │     │ }                                                                 │    │
  │     └─────────────────────────────────────────────────────────────────┘    │
  │                                                                              │
  │  【校验失败后的客户端处理】                                                   │
  │  ┌─────────────────────────────────────────────────────────────────┐    │
  │  │ 收到 "FileOffset mismatch" 错误后:                               │    │
  │  │                                                                     │    │
  │  │  1. 暂停当前上传                                                    │    │
  │  │  2. GET /uploads/{id} 获取权威进度                                 │    │
  │  │  3. 从 file.slice(authoritativeOffset) 重新准备数据              │    │
  │  │  4. 重试上传                                                        │    │
  │  └─────────────────────────────────────────────────────────────────┘    │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘

  原则 3: At-Least-Once 写入语义
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  服务端 UploadData 中的关键代码顺序:                                         │
  │                                                                              │
  │  // 1. 先写入存储                                                            │
  │  written, err = a.WriteFile(lr, uploadPath)  // 或 AppendFile             │
  │                                                                              │
  │  // 2. 只要写入了数据，就推进 FileOffset                                     │
  │  if written > 0 {                                                           │
  │      us.FileOffset += written                                               │
  │                                                                              │
  │      // 3. 持久化到数据库                                                    │
  │      if storeErr := a.Srv().Store().UploadSession().Update(us);           │
  │         storeErr != nil {                                                   │
  │          // 数据库更新失败，但文件已写入                                     │
  │          // 这种情况可能需要人工干预                                         │
  │          return nil, InternalServerError                                    │
  │      }                                                                       │
  │  }                                                                           │
  │                                                                              │
  │  // 4. 最后检查错误                                                          │
  │  if err != nil {                                                             │
  │      // 注意: 如果 written > 0，FileOffset 已经更新并持久化                 │
  │      // 下次上传将从新的 offset 继续                                         │
  │      return nil, err                                                         │
  │  }                                                                           │
  │                                                                              │
  │  【含义】                                                                     │
  │  ├── 数据一旦写入存储，就不会回滚                                            │
  │  ├── FileOffset 单调递增，不会后退                                          │
  │  ├── 客户端可以安全地从 file_offset 继续，不会重复写入已成功的数据          │
  │  └── 但客户端需要处理"部分写入"的情况（通过 GET 获取权威进度）              │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
```

### 2.4.5 失败重试策略设计

基于服务端 API 设计的理想客户端重试策略：

```typescript
// 伪代码: 分片上传的理想客户端实现
interface ResumableUploadConfig {
    file: File;
    channelId: string;
    chunkSize?: number;           // 建议 8MB 或 16MB
    maxRetries?: number;          // 每片最大重试次数
    retryDelay?: number;          // 重试延迟 (ms)
    onProgress?: (offset: number, total: number) => void;
    onComplete?: (fileInfo: FileInfo) => void;
    onError?: (error: Error) => void;
}

class ResumableFileUploader {
    private sessionId: string | null = null;
    private fileOffset: number = 0;  // 本地记录的进度 (仅供参考)
    private config: Required<ResumableUploadConfig>;
    private abortController: AbortController | null = null;
    
    constructor(config: ResumableUploadConfig) {
        this.config = {
            chunkSize: 8 * 1024 * 1024,     // 默认 8MB
            maxRetries: 3,
            retryDelay: 1000,
            ...config
        };
    }
    
    async start(): Promise<FileInfo> {
        try {
            // 阶段 1: 创建上传会话
            if (!this.sessionId) {
                const session = await this.createUploadSession();
                this.sessionId = session.id;
                this.fileOffset = session.file_offset;
            }
            
            // 阶段 2: 循环上传直到完成
            while (this.fileOffset < this.config.file.size) {
                const result = await this.uploadNextChunk();
                
                if (result.type === 'complete') {
                    this.config.onComplete?.(result.fileInfo);
                    return result.fileInfo;
                }
                
                // result.type === 'partial'
                // 继续下一片
            }
            
            throw new Error('Upload completed but no FileInfo returned');
        } catch (error) {
            this.config.onError?.(error as Error);
            throw error;
        }
    }
    
    private async createUploadSession(): Promise<UploadSession> {
        const response = await fetch('/api/v4/uploads', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Authorization header 由客户端框架处理
            },
            body: JSON.stringify({
                filename: this.config.file.name,
                file_size: this.config.file.size,
                channel_id: this.config.channelId,
                type: 'attachment'
            })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to create upload session: ${response.status}`);
        }
        
        return response.json();
    }
    
    private async uploadNextChunk(): Promise<
        { type: 'partial' } | 
        { type: 'complete'; fileInfo: FileInfo }
    > {
        const chunkStart = this.fileOffset;
        const chunkEnd = Math.min(
            this.fileOffset + this.config.chunkSize,
            this.config.file.size
        );
        
        // 特殊处理: 首片必须 >= 5MB 除非是完整文件
        if (this.fileOffset === 0 && 
            chunkEnd - chunkStart < 5 * 1024 * 1024 &&
            chunkEnd < this.config.file.size) {
            // 扩展首片到至少 5MB
            // ...
        }
        
        const chunk = this.config.file.slice(chunkStart, chunkEnd);
        
        let lastError: Error | null = null;
        
        // 重试循环
        for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
            try {
                this.abortController = new AbortController();
                
                const response = await fetch(
                    `/api/v4/uploads/${this.sessionId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/octet-stream'
                        },
                        body: chunk,
                        signal: this.abortController.signal
                    }
                );
                
                // 情况 1: 204 No Content - 上传未完成
                if (response.status === 204) {
                    // 【重要】服务端不返回新的 offset
                    // 我们需要主动查询权威进度
                    const authoritativeState = await this.getAuthoritativeState();
                    this.fileOffset = authoritativeState.file_offset;
                    
                    this.config.onProgress?.(
                        this.fileOffset,
                        this.config.file.size
                    );
                    
                    return { type: 'partial' };
                }
                
                // 情况 2: 200/201 - 上传完成
                if (response.status === 200 || response.status === 201) {
                    const fileInfo = await response.json();
                    return { type: 'complete', fileInfo };
                }
                
                // 情况 3: 错误状态码
                const errorBody = await response.text();
                
                // 特殊处理: FileOffset mismatch (并发冲突)
                if (errorBody.includes('FileOffset mismatch') ||
                    errorBody.includes('concurrent')) {
                    // 查询权威进度并重试
                    const authoritativeState = await this.getAuthoritativeState();
                    this.fileOffset = authoritativeState.file_offset;
                    
                    // 重新准备 chunk (从新的 offset 开始)
                    return { type: 'partial' };
                }
                
                // 其他错误: 重试
                throw new Error(`Upload failed: ${response.status} - ${errorBody}`);
                
            } catch (error) {
                lastError = error as Error;
                
                // 网络错误 (fetch 抛出) 或 超时
                // 查询权威进度后再决定
                const authoritativeState = await this.getAuthoritativeState();
                
                if (authoritativeState.file_offset > this.fileOffset) {
                    // 服务端已经接收了更多数据
                    // 说明上次请求部分成功
                    this.fileOffset = authoritativeState.file_offset;
                    return { type: 'partial' };
                }
                
                // 否则: 等待后重试
                if (attempt < this.config.maxRetries - 1) {
                    await this.delay(this.config.retryDelay * (attempt + 1));
                }
            }
        }
        
        throw lastError || new Error('Upload failed after max retries');
    }
    
    /**
     * 获取权威进度 - 关键方法
     * 任何时候客户端状态可能过期时都应该调用
     */
    private async getAuthoritativeState(): Promise<UploadSession> {
        const response = await fetch(`/api/v4/uploads/${this.sessionId}`, {
            method: 'GET',
            // 可以添加 cache-control: no-cache 确保不使用缓存
        });
        
        if (!response.ok) {
            throw new Error(`Failed to get upload state: ${response.status}`);
        }
        
        return response.json();
    }
    
    /**
     * 恢复上传 (客户端崩溃后重启)
     */
    async resume(sessionId: string): Promise<FileInfo> {
        this.sessionId = sessionId;
        
        // 【关键点】恢复时必须先查询权威进度
        const authoritativeState = await this.getAuthoritativeState();
        this.fileOffset = authoritativeState.file_offset;
        
        // 验证文件大小匹配
        if (authoritativeState.file_size !== this.config.file.size) {
            throw new Error('File size mismatch. Cannot resume upload.');
        }
        
        // 继续上传
        return this.start();
    }
    
    cancel(): void {
        this.abortController?.abort();
    }
    
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
```

### 2.4.6 从上传状态到消息展示的完整收敛

**两种上传方式的收敛点对比**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    收敛流程 - 从上传到消息展示                                  │
└─────────────────────────────────────────────────────────────────────────────┘

  普通上传路径                              分片上传路径
  ┌─────────────────────┐                   ┌─────────────────────┐
  │                     │                   │                     │
  │  POST /api/v4/files │                   │  1. POST /uploads   │
  │  multipart/form-data│                   │  创建会话            │
  │                     │                   │                     │
  │  一次请求完成        │                   │  2. POST /uploads/  │
  │                     │                   │  {id} (多次)        │
  │  直接返回 FileInfo   │                   │  可能失败、重试      │
  │                     │                   │  GET 查询权威进度     │
  └──────────┬──────────┘                   │  ...                │
             │                              └──────────┬──────────┘
             │                                         │
             ▼                                         ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         【收敛点: FileInfo】                                 │
  │                                                                              │
  │  两种上传方式最终输出完全相同的数据结构:                                      │
  │                                                                              │
  │  {                                                                           │
  │    "id": "file_abc123",         ← 全局唯一的文件 ID                        │
  │    "name": "report.pdf",                                                     │
  │    "size": 1048576,                                                         │
  │    "mime_type": "application/pdf",                                          │
  │    "creator_id": "user_xyz",                                                │
  │    "channel_id": "channel_abc",                                             │
  │    "post_id": "",                  ← 【关键】初始为空，等待消息关联         │
  │    "path": "20260502/teams/...",  ← 存储路径 (不返回给客户端)             │
  │    "has_preview_image": false,                                              │
  │    "width": 0,                                                              │
  │    "height": 0,                                                             │
  │    "mini_preview": null                                                     │
  │  }                                                                           │
  │                                                                              │
  │  【重要】FileInfo 与上传方式完全解耦                                         │
  │  后续流程不知道也不关心文件是怎么上传的                                       │
  └──────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         阶段: 消息草稿管理                                   │
  │                                                                              │
  │  Webapp 中的 PostDraft 数据结构:                                            │
  │                                                                              │
  │  interface PostDraft {                                                      │
  │    message: string;                     // 消息内容                          │
  │    fileInfos: FileInfo[];              // 已上传完成的文件                  │
  │    uploadsInProgress: string[];        // 上传中的 client_id 或 upload_id  │
  │    // ...                                                                   │
  │  }                                                                           │
  │                                                                              │
  │  状态转换:                                                                    │
  │                                                                              │
  │  普通上传:                                                                   │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  uploadStart(clientIds)                                               │  │
  │  │     │                                                                  │  │
  │  │     ▼                                                                  │  │
  │  │  uploadsInProgress.push(clientId)                                     │  │
  │  │     │                                                                  │  │
  │  │     ▼ (上传完成)                                                       │  │
  │  │  uploadComplete(fileInfos, clientIds)                                 │  │
  │  │     │                                                                  │  │
  │  │     ▼                                                                  │  │
  │  │  fileInfos.push(...newFileInfos)                                      │  │
  │  │  uploadsInProgress = uploadsInProgress.filter(id => !clientIds.includes(id))│
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  │  分片上传 (理想实现):                                                        │
  │  ┌──────────────────────────────────────────────────────────────────────┐  │
  │  │  1. 创建会话后:                                                        │  │
  │  │     uploadsInProgress.push(uploadSessionId)                          │  │
  │  │                                                                         │  │
  │  │  2. 每片上传进度:                                                      │  │
  │  │     更新 UI 显示: 60% complete                                        │  │
  │  │     (但不修改 fileInfos，直到全部完成)                                │  │
  │  │                                                                         │  │
  │  │  3. 失败后:                                                            │  │
  │  │     仍保留在 uploadsInProgress 中                                     │  │
  │  │     显示 "上传失败，点击重试"                                          │  │
  │  │                                                                         │  │
  │  │  4. 重试时:                                                            │  │
  │  │     GET /uploads/{id} 获取权威进度                                    │  │
  │  │     从 file_offset 继续上传                                            │  │
  │  │                                                                         │  │
  │  │  5. 全部完成:                                                          │  │
  │  │     fileInfos.push(fileInfo)                                          │  │
  │  │     uploadsInProgress = uploadsInProgress.filter(id => id !== sessionId)│
  │  └──────────────────────────────────────────────────────────────────────┘  │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         阶段: 发送消息                                       │
  │                                                                              │
  │  POST /api/v4/posts                                                         │
  │  {                                                                           │
  │    "channel_id": "channel_abc",                                            │
  │    "message": "查看这个文件",                                                │
  │    "file_ids": ["file_abc123", "file_def456"],  ← 引用 FileInfo.id       │
  │    // ...                                                                   │
  │  }                                                                           │
  │                                                                              │
  │  【关键】这里只传 file_id，不传任何上传相关的元数据                         │
  │  服务端也不关心这些文件是怎么上传的                                           │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         阶段: 服务端消息关联                                 │
  │                                                                              │
  │  服务端 app/post_file_change.go 中的统一处理:                               │
  │                                                                              │
  │  processPostFileChanges(newPost, oldPost) {                                │
  │      // 1. 从 Post.FileIds 获取新增的文件 ID                                │
  │      addedFileIDs = 新的 file_ids - 旧的 file_ids                          │
  │                                                                              │
  │      // 2. 对每个新增的 file_id:                                            │
  │      for fileID in addedFileIDs:                                            │
  │          // 从 FileInfoStore 获取文件信息                                   │
  │          fileInfo = FileInfoStore.GetForUser(                              │
  │              fileID, userId, channelId                                     │
  │          )                                                                  │
  │                                                                              │
  │          // 验证:                                                           │
  │          // - 文件存在                                                       │
  │          // - FileInfo.PostId == "" (未关联到其他消息)                     │
  │          // - CreatorId 匹配当前用户                                        │
  │          // - ChannelId 匹配                                                │
  │                                                                              │
  │          // 关联:                                                           │
  │          FileInfoStore.AttachToPost(fileID, postId, userId)              │
  │          // 更新 FileInfo.PostId = post.Id                                  │
  │                                                                              │
  │      // 3. 对每个删除的 file_id:                                            │
  │      for fileID in removedFileIDs:                                          │
  │          FileInfoStore.DeleteForPostByIds(postId, [fileID])               │
  │          // 软删除: DeleteAt = now                                          │
  │  }                                                                           │
  │                                                                              │
  │  【重要】整个过程与上传方式完全无关                                           │
  │  只通过 FileInfo 表进行关联，不关心文件是如何上传的                          │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                         阶段: 消息展示                                       │
  │                                                                              │
  │  客户端获取帖子后的渲染流程:                                                 │
  │                                                                              │
  │  1. GET /api/v4/posts 获取 Post 列表                                        │
  │                                                                              │
  │  2. 每个 Post 包含:                                                         │
  │     {                                                                        │
  │       "id": "post_xyz",                                                     │
  │       "message": "...",                                                     │
  │       "file_ids": ["file_abc123"],  ← 有序的文件 ID 列表                  │
  │       // ...                                                                │
  │     }                                                                        │
  │                                                                              │
  │  3. 服务端查询 (支持缓存):                                                   │
  │     FileInfoStore.GetForPost(postId, fromCache=true)                       │
  │     // 通过 PostId 反向查询关联的 FileInfo                                  │
  │                                                                              │
  │  4. 客户端渲染:                                                              │
  │     for fileInfo in post.fileInfos:                                         │
  │         if fileInfo.IsImage():                                              │
  │             // 显示缩略图                                                    │
  │             <img src="/api/v4/files/{fileId}/thumbnail" />                 │
  │         else:                                                                │
  │             // 显示文件图标和名称                                            │
  │             <FileIcon type={fileInfo.MimeType} />                          │
  │             <span>{fileInfo.Name}</span>                                    │
  │                                                                              │
  │  【关键点】                                                                   │
  │  - Post.FileIds 决定显示顺序                                                 │
  │  - FileInfo.PostId 用于反向查询                                              │
  │  - 整个渲染流程与上传方式完全无关                                             │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────┘
```

### 2.4.7 状态转换与收敛总结表

| 阶段 | 普通上传状态 | 分片上传状态 | 收敛点 |
|------|-------------|-------------|--------|
| **上传中** | `uploadsInProgress: [clientId]` | `uploadsInProgress: [uploadSessionId]` | 都在 `uploadsInProgress` 中等待 |
| **上传完成** | `fileInfos: [FileInfo]` | `fileInfos: [FileInfo]` | 相同的 `FileInfo` 结构 |
| **草稿中** | `PostDraft.fileInfos` | `PostDraft.fileInfos` | 相同的草稿数据结构 |
| **发送消息** | `Post.FileIds: [fileId]` | `Post.FileIds: [fileId]` | 相同的 `file_ids` 引用 |
| **服务端关联** | `FileInfo.PostId = postId` | `FileInfo.PostId = postId` | 相同的关联逻辑 |
| **消息展示** | 通过 `FileInfo.PostId` 查询 | 通过 `FileInfo.PostId` 查询 | 相同的渲染逻辑 |

**核心设计洞察**:

1. **上传方式与消息展示完全解耦**:
   - 分片上传的复杂性（会话管理、断点续传、失败重试）完全封装在上传阶段
   - 一旦生成 `FileInfo`，所有后续流程与普通上传完全一致

2. **单一真值源设计**:
   - 上传阶段: `UploadSession.FileOffset` 是权威进度
   - 消息关联阶段: `FileInfo.PostId` 是权威关联
   - 展示阶段: `Post.FileIds` 是权威顺序

3. **状态持久化策略**:
   - `UploadSession` 表: 临时状态，上传完成后删除
   - `FileInfo` 表: 永久状态，PostId 初始为空，关联后更新
   - `Post` 表: 包含 `FileIds` 数组，决定展示顺序

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
