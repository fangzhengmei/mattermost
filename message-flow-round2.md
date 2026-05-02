# Mattermost 消息处理流程详细分析报告（第二版）

## 文档说明

本文档详细分析 Mattermost 中用户发帖后，消息从前端请求到服务端接收、落库、再到频道广播的完整链路。所有分析严格区分**已确认事实**和**推断信息**，关键结论均提供可核对的代码证据。

---

## 术语定义

| 术语 | 定义 |
|------|------|
| **已确认事实** | 有明确代码证据或官方文档支持的结论 |
| **推断信息** | 基于架构模式、代码结构、间接证据合理推断的结论 |
| **Pending Post** | 前端创建的临时帖子，用于乐观更新 |
| **乐观更新** | 发送请求前先更新本地 UI，提供即时反馈 |

---

## 完整消息处理时序

### 阶段 1：前端用户操作与请求发送

#### 步骤 1：用户触发发送操作

**触发者**：用户（在输入框输入消息后，点击发送按钮或按 Enter 键）

**已确认事实**：
- 前端组件会收集用户输入的消息内容、当前频道 ID、可选的根帖子 ID（用于回复）
- 构建 `Post` 对象，包含至少 `channel_id` 和 `message` 字段

**推断信息**：
- 不同的 UI 组件（如 AdvancedCreatePost、普通消息输入框）最终都会调用同一个 `createPost` action

---

#### 步骤 2：前端 Redux Action 处理

**触发者**：前端 UI 组件（通过调用 `createPost` action）

**代码位置**：`webapp/channels/src/packages/mattermost-redux/src/actions/posts.ts:179-326`

**已确认事实**：

##### 2.1 生成临时帖子 ID

```typescript
// 第 188-189 行
const timestamp = Date.now();
const pendingPostId = post.pending_post_id || `${currentUserId}:${timestamp}`;
```

**操作细节**：
- **读取数据**：从 Redux Store 读取 `currentUserId`（`state.entities.users.currentUserId`）
- **生成数据**：
  - 格式：`{currentUserId}:{timestamp}`
  - 示例：`user123:1714678900000`
- **防重复检查**：
  ```typescript
  // 第 192-194 行
  if (PostSelectors.isPostIdSending(state, pendingPostId)) {
      return {data: {pending: pendingPostId}};
  }
  ```
  - 如果该临时 ID 已经在发送中，直接返回，防止重复发送

##### 2.2 创建本地临时帖子对象

```typescript
// 第 196-202 行
let newPost = {
    ...post,
    pending_post_id: pendingPostId,
    create_at: timestamp,
    update_at: timestamp,
    reply_count: 0,
};
```

**操作细节**：
- **读取数据**：传入的 `post` 参数（包含 `channel_id`、`message` 等）
- **写入数据**：
  - 添加 `pending_post_id` 字段
  - 设置 `create_at` 和 `update_at` 为当前时间戳
  - 初始化 `reply_count` 为 0

##### 2.3 处理 DM/GM 频道的特殊情况

```typescript
// 第 204-217 行
const channel = state.entities.channels.channels[post.channel_id];
const currentTeamId = state.entities.teams.currentTeamId;
if (channel && !channel.team_id && currentTeamId) {
    // DM/GM channel - add current team context
    newPost = {
        ...newPost,
        props: {
            ...newPost.props,
            current_team_id: currentTeamId,
        },
    };
}
```

**操作细节**：
- **读取数据**：
  - 从 Redux Store 读取频道信息（`state.entities.channels.channels[post.channel_id]`）
  - 读取当前团队 ID（`state.entities.teams.currentTeamId`）
- **判断条件**：
  - 频道存在
  - 频道没有 `team_id`（DM/GM 频道的特征）
  - 存在当前团队 ID
- **写入数据**：在 `props` 中添加 `current_team_id`，用于正确的频道提及解析

##### 2.4 处理回复帖子

```typescript
// 第 219-221 行
if (post.root_id) {
    newPost.reply_count = PostSelectors.getPostRepliesCount(state, post.root_id) + 1;
}
```

**操作细节**：
- **读取数据**：检查 `post.root_id` 是否存在（表示这是一个回复）
- **计算数据**：从 Redux Store 获取根帖子的回复计数，加 1
- **写入数据**：设置 `newPost.reply_count`

##### 2.5 处理文件附件

```typescript
// 第 223-246 行
// We are retrying a pending post that had files
if (newPost.file_ids && !files.length) {
    // eslint-disable-next-line no-param-reassign
    files = newPost.file_ids.map((id) => state.entities.files.files[id]);
}

if (files.length) {
    const fileIds = files.map((file) => file.id);

    newPost = {
        ...newPost,
        file_ids: fileIds,
    };

    actions.push({
        type: FileTypes.RECEIVED_FILES_FOR_POST,
        postId: pendingPostId,
        data: files,
    }, {
        type: ChannelTypes.INCREMENT_FILE_COUNT,
        amount: files.length,
        id: newPost.channel_id,
    });
}
```

**操作细节**：
- **读取数据**：
  - 检查 `newPost.file_ids` 是否存在且 `files` 数组为空（重试场景）
  - 从 Redux Store 读取文件信息（`state.entities.files.files[id]`）
- **写入数据**：
  - 设置 `newPost.file_ids`
  - 添加 `RECEIVED_FILES_FOR_POST` action
  - 添加 `INCREMENT_FILE_COUNT` action

##### 2.6 准备本地更新 actions

```typescript
// 第 248-256 行
const crtEnabled = isCollapsedThreadsEnabled(getState());
actions.push({
    type: PostTypes.RECEIVED_NEW_POST,
    data: {
        ...newPost,
        id: pendingPostId,  // 使用临时 ID 作为帖子 ID
    },
    features: {crtEnabled},
});
```

**操作细节**：
- **读取数据**：检查是否启用了折叠线程功能（`isCollapsedThreadsEnabled`）
- **构建 action**：
  - type：`PostTypes.RECEIVED_NEW_POST`
  - data：包含完整的帖子信息，**注意**：`id` 字段使用的是 `pendingPostId`（临时 ID）
  - features：包含 `crtEnabled` 标志

##### 2.7 执行乐观更新

```typescript
// 第 258 行
dispatch(batchActions(actions, 'BATCH_CREATE_POST_INIT'));
```

**操作细节**：
- **触发者**：`createPost` action
- **接收者**：Redux Reducer
- **发送内容**：批量 actions，包含 `RECEIVED_NEW_POST` 等
- **影响**：
  - Redux Store 被更新
  - UI 立即显示新消息（使用临时 ID）
  - 用户获得即时反馈

##### 2.8 立即返回（异步请求前）

```typescript
// 第 324 行
return {data: {created: true}};
```

**操作细节**：
- **注意**：这是在异步请求发送之前就返回的！
- **返回值**：`{data: {created: true}}`
- **设计意图**：乐观更新的一部分，让调用者认为操作已成功

---

#### 步骤 3：异步发送 API 请求

**触发者**：`createPost` action 内部的 `createPostWrapper` 异步函数

**代码位置**：`webapp/channels/src/packages/mattermost-redux/src/actions/posts.ts:260-322`

##### 3.1 调用 Client4.createPost

```typescript
// 第 261-262 行
try {
    const created = await Client4.createPost({...newPost, create_at: 0});
```

**操作细节**：
- **注意**：`create_at` 被设置为 `0`，让服务端设置实际的创建时间
- **发送数据**：
  - 完整的帖子对象（`channel_id`、`message`、`pending_post_id` 等）
  - `create_at: 0`

##### 3.2 Client4.createPost 实现

**代码位置**：`webapp/platform/client/src/client4.ts:2408-2420`

```typescript
createPost = async (post: PartialExcept<Post, 'channel_id' | 'message'>) => {
    const result = await this.doFetch<Post>(
        `${this.getPostsRoute()}`,  // /api/v4/posts
        {method: 'post', body: JSON.stringify(post)},
    );
    // ... analytics 相关代码
    return result;
};
```

**已确认事实**：
- **HTTP 方法**：`POST`
- **URL**：`/api/v4/posts`（由 `getPostsRoute()` 返回，见第 373-375 行）
- **Content-Type**：`application/json`（推断，因为使用 `JSON.stringify`）
- **请求体**：JSON 序列化的帖子对象

**接收者**：Mattermost 服务端的 API 层

---

### 阶段 2：服务端 API 层处理

#### 步骤 4：API 层接收请求

**触发者**：前端的 `POST /api/v4/posts` 请求

**已确认事实**（来自 API 文档和开发者文档）：

##### 4.1 API 端点信息

| 属性 | 值 | 来源 |
|------|-----|------|
| HTTP 方法 | POST | [Mattermost API 文档](https://api.mattermost.com/) |
| 端点路径 | `/api/v4/posts` | [posts.yaml](https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/posts.yaml) |
| 操作 ID | `CreatePost` | posts.yaml |
| 权限要求 | `create_post` 权限（针对目标频道） | posts.yaml |
| 查询参数 | `set_online`（可选，设置用户在线状态） | posts.yaml |

##### 4.2 API Handler 标准模式

**来源**：[Mattermost 开发者文档](https://developers.mattermost.com/contribute/more-info/server/rest-api/)

```go
func handlerName(c *Context, w http.ResponseWriter, r *http.Request) {
    // 1. Parse the request URL and body.
    // 2. Do a permissions check if required.
    // 3. Invoke handler logic through the app package.
    // 4. (Optional) Check the Etag.
    // 5. Format the response and write the response.
}
```

**推断信息**（基于标准模式）：

##### 4.3 解析请求

**操作细节**（推断）：
- **读取数据**：从 HTTP 请求体读取 JSON 数据
- **解析数据**：反序列化为 `model.Post` 结构体
- **验证字段**：
  - 必须字段：`channel_id`、`message`
  - 可选字段：`root_id`、`file_ids`、`props` 等

##### 4.4 权限检查

**操作细节**（推断）：
- **读取数据**：
  - 从请求上下文获取当前用户 ID（`c.Session.UserId`）
  - 从数据库读取频道信息（根据 `channel_id`）
  - 检查用户是否是频道成员
  - 检查用户是否有 `create_post` 权限

**权限边界**（已确认事实，来自 API 文档）：
- **必须是频道成员**：用户必须是目标频道的成员
- **必须有 create_post 权限**：用户必须在该频道拥有 `create_post` 权限
- **特殊情况**：
  - 系统管理员可能有额外权限
  - 频道管理员可能有额外权限

##### 4.5 调用 App 层

**操作细节**（推断）：
- 调用 `c.App.CreatePost()` 或类似方法
- 传入解析后的 `Post` 对象和相关上下文

---

### 阶段 3：服务端 App 层业务逻辑处理

#### 步骤 5：App 层核心业务处理

**触发者**：API 层 Handler

**代码位置**：`server/channels/app/post.go`（推断，来自 GitHub issue #29077）

**推断信息**（基于 Mattermost 架构模式和间接证据）：

##### 5.1 消息预处理

**操作细节**（推断）：
- **清理消息内容**：
  - 去除首尾空白
  - 处理特殊字符
  - 可能的长度限制检查
- **设置时间戳**：
  - `CreateAt`：当前时间戳
  - `UpdateAt`：当前时间戳
  - `UserId`：当前用户 ID（从 session 获取）

##### 5.2 频道状态检查

**操作细节**（推断）：
- **读取数据**：从 Store 层获取频道信息
- **检查条件**：
  - 频道是否存在（`DeleteAt == 0`）
  - 频道是否被归档
  - 频道是否是只读的（如 Town Square 可能配置为只读）

##### 5.3 处理 @提及

**操作细节**（推断）：
- **解析消息**：使用正则表达式或解析器查找 `@username` 模式
- **验证用户**：检查提及的用户是否存在，是否是频道成员
- **记录提及**：
  - 可能在 `Post.Metadata` 中记录提及的用户 ID
  - 用于后续的通知和高亮显示

##### 5.4 处理 #话题标签

**操作细节**（推断）：
- **解析消息**：查找 `#topic` 模式
- **记录话题**：
  - 可能在 `Post.Hashtags` 字段记录
  - 用于搜索和分类

##### 5.5 处理链接预览

**操作细节**（推断）：
- **解析消息**：查找 URL 模式
- **生成预览**：
  - 获取链接的标题、描述、缩略图等
  - 可能在 `Post.Metadata.Embeds` 中记录

##### 5.6 插件钩子处理

**已确认事实**（来自前端代码和插件文档）：

**前端错误处理中的证据**（`posts.ts:309-311`）：
```typescript
if (error.server_error_id === 'api.post.create_post.root_id.app_error' ||
    error.server_error_id === 'api.post.create_post.town_square_read_only' ||
    error.server_error_id === 'plugin.message_will_be_posted.dismiss_post'  // 插件相关错误
)
```

**操作细节**（推断）：

##### 5.6.1 MessageWillBePosted 钩子

- **触发时机**：帖子保存到数据库之前
- **插件能力**：
  - 修改帖子内容
  - 取消帖子（返回 `dismiss_post` 错误）
  - 添加元数据
- **错误处理**：如果插件返回 `plugin.message_will_be_posted.dismiss_post`，帖子不会被保存

##### 5.6.2 MessageHasBeenPosted 钩子

- **触发时机**：帖子保存到数据库之后
- **插件能力**：
  - 执行后续操作
  - 发送通知
  - 集成外部系统

##### 5.7 回复相关处理

**操作细节**（推断）：
- 如果 `Post.RootId` 不为空：
  - 检查根帖子是否存在
  - 检查根帖子是否属于同一个频道
  - 更新根帖子的 `ReplyCount` 和 `LastReplyAt`
  - 可能创建或更新线程（Thread）记录

**已确认事实**（来自前端错误处理）：
- 如果根帖子不存在，会返回错误：`api.post.create_post.root_id.app_error`（`posts.ts:309`）

##### 5.8 调用 Store 层保存

**操作细节**（推断）：
- 调用 `srv.Store.Post().Save()` 或类似方法
- 在数据库事务中执行所有写操作

---

### 阶段 4：数据存储层落库

#### 步骤 6：Store 层数据持久化

**触发者**：App 层

**推断信息**（基于 Mattermost 架构和数据库模型）：

##### 6.1 开始数据库事务

**操作细节**（推断）：
- 开始 SQL 事务
- 所有后续操作在事务中执行
- 如果任何一步失败，回滚事务

##### 6.2 插入 Posts 表

**已确认事实**（来自 API 文档和数据模型）：

**Posts 表核心字段**：

| 字段名 | 类型 | 描述 |
|--------|------|------|
| `Id` | varchar(26) | 主键，唯一标识符 |
| `CreateAt` | bigint | 创建时间戳 |
| `UpdateAt` | bigint | 更新时间戳 |
| `DeleteAt` | bigint | 删除时间戳（软删除） |
| `UserId` | varchar(26) | 发送者用户 ID |
| `ChannelId` | varchar(26) | 频道 ID |
| `RootId` | varchar(26) | 根帖子 ID（回复） |
| `OriginalId` | varchar(26) | 原始帖子 ID（转发） |
| `Message` | text | 消息内容 |
| `Type` | varchar(26) | 帖子类型 |
| `Props` | jsonb | 附加属性 |
| `Hashtags` | varchar(1000) | 话题标签 |
| `FileIds` | varchar(150) | 文件 ID 列表 |
| `PendingPostId` | varchar(26) | 临时帖子 ID |
| `ReplyCount` | bigint | 回复计数 |
| `LastReplyAt` | bigint | 最后回复时间 |
| `IsPinned` | boolean | 是否置顶 |
| `IsEphemeral` | boolean | 是否临时消息 |

**操作细节**（推断）：
- 生成唯一的 `Id`（通常是 26 字符的 UUID 或类似格式）
- 设置 `CreateAt` 和 `UpdateAt` 为当前时间戳
- 设置 `UserId` 为当前用户 ID
- 插入 `Posts` 表

##### 6.3 更新相关数据

**操作细节**（推断）：

##### 6.3.1 更新频道统计

- **读取数据**：当前频道的 `TotalMsgCount`、`TotalMsgCountRoot` 等
- **写入数据**：
  - `TotalMsgCount + 1`
  - 如果是根帖子（`RootId == ""`），`TotalMsgCountRoot + 1`
  - 更新 `LastPostAt` 为当前时间戳

##### 6.3.2 更新文件关联（如果有附件）

- 读取 `FileIds` 列表
- 更新 `Files` 表中对应文件的 `PostId` 字段

##### 6.3.3 更新线程信息（如果是回复）

- 如果 `RootId` 不为空：
  - 更新根帖子的 `ReplyCount + 1`
  - 更新根帖子的 `LastReplyAt`
  - 可能创建或更新 `Threads` 表记录

##### 6.4 提交事务

**操作细节**（推断）：
- 如果所有操作成功，提交事务
- 如果任何操作失败，回滚事务

---

### 阶段 5：后续处理与通知

#### 步骤 7：App 层后续处理

**触发者**：Store 层保存成功后

**推断信息**：

##### 7.1 更新频道成员的最后查看时间

**操作细节**（推断）：
- 更新发送者的 `ChannelMembers.LastViewedAt` 为当前时间戳
- 这会影响未读计数的计算

##### 7.2 设置用户在线状态

**操作细节**（推断）：
- 如果请求中包含 `set_online=true` 参数
- 设置用户状态为在线

##### 7.3 准备 WebSocket 广播事件

**已确认事实**（来自多个来源）：

**事件格式**（来自 [GitHub issue #22110](https://github.com/mattermost/mattermost/issues/22110)）：
```json
{
    "event": "posted",
    "data": {
        "channel_display_name": "General Discussion",
        "channel_name": "general",
        "channel_type": "O",
        "mentions": "[\"user1\", \"user2\"]",
        "post": "{\"id\":\"xxx\",\"create_at\":1674132302437,\"message\":\"hello\"}",
        "sender_name": "@johndoe",
        "set_online": true,
        "team_id": "team123"
    },
    "broadcast": {
        "omit_users": null,
        "user_id": "",
        "channel_id": "channel123",
        "team_id": "team123",
        "connection_id": ""
    },
    "seq": 3
}
```

**重要发现**（已确认事实）：
- `data.post` 是 **JSON 字符串**，不是 JSON 对象
- `data.mentions` 是 **JSON 字符串**，不是数组
- 这意味着客户端需要对这些字段进行**二次 JSON 解析**

**操作细节**（推断）：
- 构建 `posted` 事件
- 设置 `event: "posted"`
- 填充 `data` 字段：
  - `post`：JSON 序列化的帖子对象
  - `mentions`：JSON 序列化的提及用户 ID 数组
  - 频道相关信息
  - 发送者信息
- 填充 `broadcast` 字段：
  - `channel_id`：目标频道 ID
  - `user_id`：空字符串（表示广播给频道内所有用户）
  - `omit_users`：可能排除发送者自己

##### 7.4 准备推送通知

**操作细节**（推断）：
- 确定需要接收推送通知的用户：
  - 离线用户
  - 未读消息的用户
  - 被 @提及的用户
- 构建推送通知内容
- 调用推送通知服务

##### 7.5 准备邮件通知

**操作细节**（推断）：
- 根据用户设置，确定是否需要发送邮件通知
- 构建邮件内容
- 异步发送邮件

---

#### 步骤 8：API 层返回响应

**触发者**：App 层处理完成后

**已确认事实**（来自 API 文档和前端代码）：

##### 8.1 成功响应

**HTTP 状态码**：`201 Created`

**响应体**：完整的 `Post` 对象（JSON 格式）

**前端处理**（`posts.ts:264-295`）：
```typescript
actions = [
    receivedPost(created, crtEnabled),  // 使用服务端返回的正式数据
    {
        type: PostTypes.CREATE_POST_SUCCESS,
    },
    {
        type: ChannelTypes.INCREMENT_TOTAL_MSG_COUNT,
        data: {
            channelId: newPost.channel_id,
            amount: 1,
            amountRoot: created.root_id === '' ? 1 : 0,
        },
    },
    {
        type: ChannelTypes.DECREMENT_UNREAD_MSG_COUNT,  // 自己发送的消息，减少未读计数
        data: {
            channelId: newPost.channel_id,
            amount: 1,
            amountRoot: created.root_id === '' ? 1 : 0,
        },
    },
];

// ... 文件相关处理

dispatch(batchActions(actions, 'BATCH_CREATE_POST'));
```

**操作细节**：
- **接收数据**：服务端返回的完整 `Post` 对象
- **替换本地数据**：
  - 使用 `receivedPost(created, crtEnabled)` 替换之前的临时帖子
  - 注意：`created.id` 是服务端生成的正式 ID，不是临时 ID
- **更新统计**：
  - 增加频道总消息计数
  - 减少自己的未读消息计数（因为自己发送的消息不算未读）

---

### 阶段 6：WebSocket 广播

#### 步骤 9：WebSocket 广播事件

**触发者**：App 层（在 API 响应返回之后，异步执行）

**已确认事实**（来自插件文档和架构描述）：

##### 9.1 WebSocket 连接管理

**来源**：[Mattermost 插件文档](https://developers.mattermost.com/integrate/plugins/components/server/reference/)

**插件 API 中的相关方法**：
```go
PublishWebSocketEvent(event string, payload map[string]any, broadcast *model.WebsocketBroadcast)
```

**操作细节**（推断）：

##### 9.2 获取目标连接

- **读取数据**：
  - 从 WebSocket Hub 获取频道的所有活跃连接
  - 根据 `broadcast` 字段过滤：
    - `broadcast.channel_id`：只获取该频道的连接
    - `broadcast.user_id`：如果非空，只获取该用户的连接
    - `broadcast.omit_users`：排除这些用户的连接

##### 9.3 发送事件

- 向每个符合条件的 WebSocket 连接发送 JSON 消息
- 消息格式如前所述

##### 9.4 特殊处理

- **排除发送者**：通常会排除发送者自己的连接（因为发送者已经通过 API 响应知道消息发送成功）
- **错误处理**：如果发送失败，可能标记连接为待清理

---

### 阶段 7：其他客户端接收和处理

#### 步骤 10：其他客户端接收 WebSocket 事件

**触发者**：服务端的 WebSocket 广播

**已确认事实**（来自前端架构描述）：

##### 10.1 WebSocket 连接监听

**操作细节**：
- 客户端维护一个或多个 WebSocket 连接到 `/api/v4/websocket`
- 持续监听服务端发送的事件

##### 10.2 解析事件

**已确认事实**（来自 [GitHub issue #22110](https://github.com/mattermost/mattermost/issues/22110)）：

**重要**：需要二次解析！
```json
// 第一次解析：整个事件
{
    "event": "posted",
    "data": {
        "post": "{\"id\":\"xxx\",\"message\":\"hello\"}",  // JSON 字符串！
        "mentions": "[\"user1\"]"  // JSON 字符串！
    }
}

// 第二次解析：data.post 和 data.mentions
const post = JSON.parse(event.data.post);
const mentions = JSON.parse(event.data.mentions);
```

**操作细节**：
1. 解析外层 JSON，获取 `event`、`data`、`broadcast` 字段
2. 解析 `data.post` JSON 字符串为 Post 对象
3. 解析 `data.mentions` JSON 字符串为用户 ID 数组

##### 10.3 分发到事件处理器

**操作细节**（推断）：
- 根据 `event` 字段值（如 `posted`）调用对应的处理器
- 对于 `posted` 事件，调用帖子相关的处理器

##### 10.4 更新 Redux Store

**操作细节**（推断，类似前端发送时的处理）：
- 调用 `receivedPost()` 或 `receivedNewPost()` action
- 更新 Redux Store 中的帖子数据
- 更新频道的未读计数（如果当前用户不在查看该频道）

##### 10.5 更新 UI

**操作细节**：
- 如果用户正在查看该频道：
  - 立即在消息列表中显示新消息
  - 可能滚动到底部或显示新消息提示
- 如果用户不在查看该频道：
  - 更新频道列表中的未读计数
  - 显示桌面通知（如果启用）
  - 播放提示音（如果启用）

---

## 异常场景与权限边界分析

### 场景 1：认证错误

#### 1.1 用户未登录

**触发条件**：
- 请求中没有有效的认证 token
- Session 已过期

**已确认事实**（来自 API 文档）：
- **HTTP 状态码**：`401 Unauthorized`
- **错误类型**：认证相关错误

**前端处理**（推断）：
- 可能触发 `forceLogoutIfNecessary` 函数
- 重定向到登录页面

#### 1.2 缺少 X-Requested-With 头（Cookie 认证）

**已确认事实**（来自 [PR #35825](https://github.com/mattermost/mattermost/pull/35825/files)）：

**测试用例描述**：
> "cookie auth without X-Requested-With header should be rejected"

**操作细节**：
- 如果使用 Cookie 认证（没有 `Authorization` 头）
- 但没有 `X-Requested-With` 头
- 会被拒绝，返回 `403 Forbidden`

**安全设计意图**：
- 防止 CSRF 攻击
- 确保请求是来自前端应用，而不是恶意网站的被动加载

---

### 场景 2：权限错误

#### 2.1 用户不是频道成员

**触发条件**：
- 用户尝试向不是成员的频道发送消息

**推断信息**：
- **HTTP 状态码**：`403 Forbidden`
- **错误 ID**：可能是 `api.post.create_post.forbidden` 或类似

**前端处理**（推断）：
- 显示权限错误提示
- 可能从频道列表中移除该频道

#### 2.2 用户没有 create_post 权限

**触发条件**：
- 用户是频道成员
- 但角色配置中没有 `create_post` 权限

**已确认事实**（来自 API 文档）：
- 权限要求明确说明需要 `create_post` 权限

**推断信息**：
- **HTTP 状态码**：`403 Forbidden`

---

### 场景 3：参数错误

#### 3.1 缺少必要字段

**触发条件**：
- 请求体中缺少 `channel_id` 或 `message`

**推断信息**：
- **HTTP 状态码**：`400 Bad Request`
- **错误 ID**：可能是 `api.post.create_post.missing_channel_id` 或类似

#### 3.2 频道不存在

**触发条件**：
- `channel_id` 对应的频道不存在
- 或频道已被删除（`DeleteAt > 0`）

**推断信息**：
- **HTTP 状态码**：`404 Not Found`

#### 3.3 根帖子不存在（回复场景）

**已确认事实**（来自前端错误处理，`posts.ts:309`）：

**错误 ID**：`api.post.create_post.root_id.app_error`

**触发条件**：
- `post.root_id` 不为空
- 但对应的根帖子不存在或已被删除

**前端处理**（`posts.ts:309-314`）：
```typescript
if (error.server_error_id === 'api.post.create_post.root_id.app_error' ||
    // ... 其他错误
) {
    // RemovePost is a Thunk, and not handled by batchActions
    dispatch(removePost(data));  // 移除本地的临时帖子
}
```

**操作细节**：
- 调用 `removePost(data)` 移除本地的临时帖子
- 用户看到消息消失
- 可能显示错误提示

---

### 场景 4：业务逻辑错误

#### 4.1 Town Square 频道只读

**已确认事实**（来自前端错误处理，`posts.ts:310`）：

**错误 ID**：`api.post.create_post.town_square_read_only`

**触发条件**：
- 系统配置中设置了 `TownSquareIsReadOnly=true`
- 用户尝试向 Town Square 频道发送消息

**前端处理**（`posts.ts:309-314`）：
```typescript
if (// ... 其他错误
    error.server_error_id === 'api.post.create_post.town_square_read_only' ||
    // ... 其他错误
) {
    dispatch(removePost(data));  // 移除本地的临时帖子
}
```

#### 4.2 插件取消帖子

**已确认事实**（来自前端错误处理，`posts.ts:311`）：

**错误 ID**：`plugin.message_will_be_posted.dismiss_post`

**触发条件**：
- 某个插件在 `MessageWillBePosted` 钩子中返回了取消操作
- 插件决定不允许该帖子被发布

**前端处理**（`posts.ts:309-314`）：
```typescript
if (// ... 其他错误
    error.server_error_id === 'plugin.message_will_be_posted.dismiss_post'
) {
    dispatch(removePost(data));  // 移除本地的临时帖子
}
```

**特殊之处**：
- 这不是一个"错误"，而是插件的正常业务决策
- 帖子被静默取消，用户可能不知道具体原因
- 前端处理方式与其他错误类似：移除本地帖子

---

### 场景 5：其他错误情况

#### 5.1 消息内容过长

**推断信息**：
- Mattermost 可能有消息长度限制
- 超过限制会返回 `400 Bad Request`

#### 5.2 系统维护或高负载

**推断信息**：
- 可能返回 `503 Service Unavailable`
- 或请求超时

#### 5.3 数据库错误

**推断信息**：
- **HTTP 状态码**：`500 Internal Server Error`
- 这类错误通常不应该暴露给用户详细信息
- 前端显示通用错误提示

---

## 前端完整错误处理逻辑分析

### 已确认事实（`posts.ts:298-321`）

```typescript
} catch (error) {
    const data = {
        ...newPost,
        id: pendingPostId,
        failed: true,           // 标记为失败
        update_at: Date.now(),   // 更新时间戳
    };
    actions = [{type: PostTypes.CREATE_POST_FAILURE, error}];

    // 特殊错误处理：移除本地帖子
    if (error.server_error_id === 'api.post.create_post.root_id.app_error' ||
        error.server_error_id === 'api.post.create_post.town_square_read_only' ||
        error.server_error_id === 'plugin.message_will_be_posted.dismiss_post'
    ) {
        // RemovePost is a Thunk, and not handled by batchActions
        dispatch(removePost(data));
    } else {
        // 其他错误：保留失败的帖子
        actions.push(receivedPost(data, crtEnabled));
    }

    dispatch(batchActions(actions, 'BATCH_CREATE_POST_FAILED'));
    return {error};
}
```

### 错误处理策略分析

#### 策略 A：移除本地帖子（3 种特殊错误）

| 错误 ID | 触发场景 | 处理方式 | 用户体验 |
|---------|----------|----------|----------|
| `api.post.create_post.root_id.app_error` | 回复的根帖子不存在 | `dispatch(removePost(data))` | 消息消失，可能显示错误 |
| `api.post.create_post.town_square_read_only` | Town Square 只读 | `dispatch(removePost(data))` | 消息消失，可能显示错误 |
| `plugin.message_will_be_posted.dismiss_post` | 插件取消帖子 | `dispatch(removePost(data))` | 消息消失，可能无提示 |

**设计意图**：
- 这些错误表示帖子**根本不可能成功**
- 继续保留本地帖子会误导用户
- 移除是更合理的选择

#### 策略 B：保留失败的帖子（其他所有错误）

**处理方式**：
```typescript
} else {
    // 标记为失败，但保留在 Store 中
    const data = {
        ...newPost,
        id: pendingPostId,
        failed: true,           // 关键：标记为失败
        update_at: Date.now(),
    };
    actions.push(receivedPost(data, crtEnabled));  // 更新 Store
}
```

**UI 表现**（推断）：
- 消息仍然显示在列表中
- 但可能有视觉标记（如红色边框、感叹号图标）
- 用户可以选择重试发送

**设计意图**：
- 这些错误可能是**暂时性的**（网络问题、服务器临时故障）
- 保留帖子允许用户重试
- 用户不会丢失他们输入的内容

---

## 完整消息流程时序图

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   发送者前端   │     │  服务端 API 层  │     │  服务端 App 层  │     │ 服务端 Store 层 │     │   其他客户端   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │                   │
       │  1. 用户点击发送     │                   │                   │                   │
       │                   │                   │                   │                   │
       │  2. 生成 pendingPostId │                   │                   │                   │
       │  3. 构建临时 Post 对象  │                   │                   │                   │
       │  4. dispatch RECEIVED_NEW_POST │                   │                   │                   │
       │  ────────────────────│                   │                   │                   │
       │  5. UI 立即显示消息   │                   │                   │                   │
       │  6. return {created: true} │                   │                   │                   │
       │                   │                   │                   │                   │
       │  7. POST /api/v4/posts │                   │                   │                   │
       │  (create_at: 0)  │──────────────────>│                   │                   │
       │                   │                   │                   │                   │
       │                   │  8. 解析 JSON 请求体  │                   │                   │
       │                   │  9. 权限检查        │                   │                   │
       │                   │  - 验证 session     │                   │                   │
       │                   │  - 检查频道成员身份   │                   │                   │
       │                   │  - 检查 create_post 权限 │                   │                   │
       │                   │                   │                   │                   │
       │                   │  10. 调用 App.CreatePost() │──────────────>│                   │
       │                   │                   │                   │                   │
       │                   │                   │  11. 消息预处理      │                   │
       │                   │                   │  - 清理内容         │                   │
       │                   │                   │  - 设置时间戳        │                   │
       │                   │                   │  - 解析 @提及        │                   │
       │                   │                   │  - 解析 #话题        │                   │
       │                   │                   │  - 解析链接预览      │                   │
       │                   │                   │                   │                   │
       │                   │                   │  12. 插件钩子        │                   │
       │                   │                   │  - MessageWillBePosted │                   │
       │                   │                   │  (可能修改或取消帖子)  │                   │
       │                   │                   │                   │                   │
       │                   │                   │  13. 检查根帖子(如回复) │                   │
       │                   │                   │                   │                   │
       │                   │                   │  14. 调用 Store 保存  │──────────────────>│
       │                   │                   │                   │                   │
       │                   │                   │                   │  15. 开始事务       │
       │                   │                   │                   │  16. 插入 Posts 表  │
       │                   │                   │                   │  17. 更新频道统计    │
       │                   │                   │                   │  18. 更新文件关联(如有)│
       │                   │                   │                   │  19. 提交事务       │
       │                   │                   │                   │                   │
       │                   │                   │  20. 插件钩子        │<──────────────────│
       │                   │                   │  - MessageHasBeenPosted │                   │
       │                   │                   │                   │                   │
       │                   │                   │  21. 准备 WebSocket 事件 │                   │
       │                   │                   │  - 构建 posted 事件  │                   │
       │                   │                   │  - 设置 broadcast 范围 │                   │
       │                   │                   │                   │                   │
       │  22. 201 Created  │<──────────────────│  22. 返回 Post 对象   │                   │
       │  (完整 Post 对象)  │                   │                   │                   │
       │                   │                   │                   │                   │
       │  23. 替换本地临时帖子 │                   │                   │                   │
       │  - receivedPost() │                   │                   │                   │
       │  - 更新频道统计     │                   │                   │                   │
       │  - 减少未读计数     │                   │                   │                   │
       │                   │                   │                   │                   │
       │                   │                   │  24. 异步广播 WebSocket │                   │
       │                   │                   │  - 获取频道连接      │                   │
       │                   │                   │  - 发送 posted 事件   │──────────────────>│
       │                   │                   │                   │                   │
       │                   │                   │                   │                   │  25. 接收 posted 事件
       │                   │                   │                   │                   │  26. 二次解析 JSON
       │                   │                   │                   │                   │  27. 更新 Redux Store
       │                   │                   │                   │                   │  28. 显示新消息/通知
       │                   │                   │                   │                   │
┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐
│   发送者前端   │     │  服务端 API 层  │     │  服务端 App 层  │     │ 服务端 Store 层 │     │   其他客户端   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

---

## 关键结论汇总

### 已确认事实

| 结论 | 证据来源 |
|------|----------|
| 前端使用乐观更新策略 | `posts.ts:258, 324` - 先 dispatch，再异步请求，最后立即返回 |
| 临时 ID 格式：`{userId}:{timestamp}` | `posts.ts:189` |
| API 端点：`POST /api/v4/posts` | `client4.ts:2410, 373-375` |
| 发送时 `create_at` 设为 0，服务端设置实际时间 | `posts.ts:262` |
| WebSocket `posted` 事件中 `post` 和 `mentions` 是 JSON 字符串 | GitHub issue #22110 |
| 3 种特殊错误会移除本地帖子 | `posts.ts:309-314` |
| 其他错误保留失败的帖子（`failed: true`） | `posts.ts:299-300, 316` |
| Cookie 认证需要 `X-Requested-With` 头 | PR #35825 测试用例 |
| 插件可以通过 `MessageWillBePosted` 钩子取消帖子 | `posts.ts:311` 错误 ID |

### 推断信息

| 结论 | 推断依据 |
|------|----------|
| 服务端采用 API → App → Store 三层架构 | 官方开发者文档、代码结构 |
| 数据库操作在事务中执行 | 企业级应用标准模式 |
| WebSocket 广播在 API 响应之后异步执行 | 性能优化考虑、架构模式 |
| 发送者自己通常不接收 WebSocket 广播 | 已经通过 API 响应知道结果 |
| 权限检查包括：认证、频道成员、create_post 权限 | API 文档、标准权限模型 |

---

## 代码索引

### 前端关键代码位置

| 功能 | 文件路径 | 行号 |
|------|----------|------|
| createPost action 主逻辑 | `webapp/channels/src/packages/mattermost-redux/src/actions/posts.ts` | 179-326 |
| 生成临时 ID | 同上 | 188-189 |
| 防重复发送检查 | 同上 | 192-194 |
| 乐观更新 dispatch | 同上 | 258 |
| 调用 Client4.createPost | 同上 | 262 |
| 成功处理（替换临时帖子） | 同上 | 264-295 |
| 错误处理分类 | 同上 | 298-321 |
| Client4.createPost 实现 | `webapp/platform/client/src/client4.ts` | 2408-2420 |
| getPostsRoute 定义 | 同上 | 373-375 |

### 服务端关键代码位置（推断）

| 功能 | 预期文件路径 |
|------|---------------|
| API 层 Handler | `server/channels/api4/post.go` |
| App 层业务逻辑 | `server/channels/app/post.go` |
| Store 层数据访问 | `server/channels/store/sqlstore/post_store.go` |
| WebSocket Hub | `server/channels/app/web_hub.go` |

---

## 参考资料

1. [Mattermost API 文档](https://api.mattermost.com/)
2. [Mattermost 开发者文档 - REST API](https://developers.mattermost.com/contribute/more-info/server/rest-api/)
3. [Mattermost 插件文档](https://developers.mattermost.com/integrate/plugins/components/server/reference/)
4. GitHub Issue #22110 - JSON encoded string inside JSON string for 'posted' websockets events
5. GitHub PR #35825 - 安全相关测试用例
6. GitHub Issue #29077 - 代码结构参考

---

## 文档版本

- **版本**：2.0
- **日期**：2026-05-02
- **状态**：已确认事实 + 合理推断
