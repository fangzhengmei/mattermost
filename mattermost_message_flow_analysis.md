# Mattermost 消息处理流程分析报告

## 概述

本文档详细分析 Mattermost 中用户在客户端发帖后，消息从前端提交到 Go 服务端接收、存储，再通过 WebSocket 广播给频道内其他成员的完整链路，以及各组件之间的协作方式。

---

## 1. 整体架构概览

Mattermost 采用典型的三层架构设计：

1. **访问层（Access Layer）**：包括 Web 界面、桌面客户端、移动应用等
2. **应用层（Application Layer）**：Mattermost Server，处理 API 请求、认证、通知等
3. **后端基础设施（Backend Infrastructure）**：数据库、文件存储、搜索引擎等

### 核心组件

- **RESTful JSON Web Service**：处理所有 API 请求
- **Authentication**：用户认证管理
- **Notification Service**：推送通知和邮件通知
- **Data Management Service**：数据存储和管理
- **WebSocket Service**：实时通信

---

## 2. 前端消息提交流程

### 2.1 技术栈

- **前端框架**：React + TypeScript
- **状态管理**：Redux + Redux Thunk
- **网络请求**：Axios（REST API）+ WebSocket（实时通信）

### 2.2 消息提交流程详解

当用户在 Mattermost 客户端输入消息并点击发送时，流程如下：

#### 步骤 1：触发发送动作

用户点击发送按钮或按 Enter 键，触发 `createPost` action。

#### 步骤 2：创建本地临时帖子（Pending Post）

在 `webapp/channels/src/packages/mattermost-redux/src/actions/posts.ts` 中的 `createPost` 函数：

1. **生成临时 ID**：使用 `currentUserId:timestamp` 格式生成临时 post ID
2. **创建本地帖子对象**：包含消息内容、频道 ID、用户 ID 等信息
3. **更新 Redux Store**：通过 `RECEIVED_NEW_POST` action 将临时帖子添加到 store 中
4. **UI 立即更新**：用户可以立即看到自己发送的消息，提供即时反馈

**关键代码逻辑**：
```typescript
// 生成临时帖子 ID
const timestamp = Date.now();
const pendingPostId = post.pending_post_id || `${currentUserId}:${timestamp}`;

// 创建临时帖子对象
let newPost = {
    ...post,
    pending_post_id: pendingPostId,
    create_at: timestamp,
    update_at: timestamp,
    reply_count: 0,
};

// 立即更新 UI
dispatch(batchActions(actions, 'BATCH_CREATE_POST_INIT'));
```

#### 步骤 3：异步发送 API 请求

在本地更新 UI 后，通过异步函数调用 `Client4.createPost` 方法发送 HTTP POST 请求到服务端：

1. **构建请求**：使用 `POST` 方法，URL 为 `/api/v4/posts`
2. **请求体**：包含帖子的完整信息（`channel_id`、`message` 等）
3. **处理响应**：
   - **成功**：更新 Redux Store，将临时帖子替换为服务端返回的正式帖子
   - **失败**：标记帖子为失败状态，显示错误信息

**关键代码逻辑**：
```typescript
// 异步发送请求
(async function createPostWrapper() {
    try {
        const created = await Client4.createPost({...newPost, create_at: 0});
        
        // 成功处理：更新 Redux Store
        actions = [
            receivedPost(created, crtEnabled),
            { type: PostTypes.CREATE_POST_SUCCESS },
            // ... 其他更新
        ];
        dispatch(batchActions(actions, 'BATCH_CREATE_POST'));
    } catch (error) {
        // 失败处理：标记为失败
        actions = [{ type: PostTypes.CREATE_POST_FAILURE, error }];
        // ...
    }
}());
```

#### 步骤 4：Client4.createPost 方法

在 `webapp/platform/client/src/client4.ts` 中的 `createPost` 方法：

```typescript
createPost = async (post: PartialExcept<Post, 'channel_id' | 'message'>) => {
    const result = await this.doFetch<Post>(
        `${this.getPostsRoute()}`,  // /api/v4/posts
        { method: 'post', body: JSON.stringify(post) },
    );
    return result;
};
```

---

## 3. 服务端 API 接收和处理逻辑

### 3.1 服务端技术栈

- **编程语言**：Go
- **Web 框架**：自定义轻量级框架
- **API 版本**：v4（`/api/v4` 前缀）

### 3.2 服务端架构分层

Mattermost 服务端采用清晰的分层架构：

1. **API 层（api4）**：处理 HTTP 请求，参数验证，响应格式化
2. **App 层（app）**：核心业务逻辑，事务管理，权限检查
3. **Store 层（store）**：数据访问层，与数据库交互

### 3.3 API 层处理

#### 路由注册

在服务端的路由定义中，`POST /api/v4/posts` 端点会被注册并映射到对应的处理函数。

#### 请求处理流程

1. **请求解析**：从 HTTP 请求中解析 JSON  body
2. **参数验证**：验证必要字段（`channel_id`、`message` 等）
3. **权限检查**：验证用户是否有权限在该频道发送消息
4. **调用 App 层**：将处理委托给 App 层的 `CreatePost` 方法

### 3.4 App 层业务逻辑

App 层是消息处理的核心，包含以下关键步骤：

#### 步骤 1：预处理和验证

1. **清理消息内容**：去除多余空白，处理特殊字符
2. **检查频道状态**：确保频道存在且未被删除
3. **验证用户权限**：确认用户是频道成员且有发送消息的权限
4. **处理特殊消息**：如系统消息、机器人消息等

#### 步骤 2：生成帖子元数据

1. **生成唯一 ID**：使用 Mattermost 的 ID 生成算法
2. **设置时间戳**：`create_at`、`update_at` 字段
3. **处理 @提及**：解析消息中的 @用户名，提取提及的用户 ID
4. **处理 #话题**：解析消息中的 #话题标签
5. **处理链接**：检测消息中的链接，生成预览信息

#### 步骤 3：存储帖子

调用 Store 层将帖子保存到数据库（详见第 4 节）。

#### 步骤 4：触发后续处理

帖子保存成功后，App 层会触发一系列后续处理：

1. **更新频道统计**：增加频道的消息计数
2. **更新用户统计**：更新用户的消息发送统计
3. **处理插件钩子**：调用插件的 `MessageWillBePosted` 和 `MessageHasBeenPosted` 钩子
4. **发送通知**：
   - **WebSocket 通知**：向频道内所有成员广播新消息事件
   - **推送通知**：向离线或未读消息的用户发送移动推送通知
   - **邮件通知**：根据用户设置，发送邮件通知

---

## 4. 消息存储机制

### 4.1 数据库选择

Mattermost 支持多种数据库：
- **PostgreSQL**：推荐用于生产环境
- **MySQL/MariaDB**：支持
- **SQLite**：仅限开发测试

### 4.2 数据模型

#### Posts 表结构

核心的帖子存储表包含以下主要字段：

| 字段名 | 类型 | 描述 |
|--------|------|------|
| `Id` | varchar(26) | 主键，唯一标识符 |
| `CreateAt` | bigint | 创建时间戳 |
| `UpdateAt` | bigint | 更新时间戳 |
| `DeleteAt` | bigint | 删除时间戳（软删除） |
| `UserId` | varchar(26) | 发送者用户 ID |
| `ChannelId` | varchar(26) | 频道 ID |
| `RootId` | varchar(26) | 根帖子 ID（用于回复） |
| `OriginalId` | varchar(26) | 原始帖子 ID（用于转发） |
| `Message` | text | 消息内容 |
| `Type` | varchar(26) | 帖子类型（普通、系统等） |
| `Props` | jsonb | 附加属性（JSON 格式） |
| `Hashtags` | varchar(1000) | 话题标签 |
| `FileIds` | varchar(150) | 附件文件 ID 列表 |
| `PendingPostId` | varchar(26) | 临时帖子 ID |
| `ReplyCount` | bigint | 回复计数 |
| `LastReplyAt` | bigint | 最后回复时间 |
| `IsPinned` | boolean | 是否置顶 |
| `IsEphemeral` | boolean | 是否临时消息 |

#### 相关表

- **Channels**：频道信息
- **Users**：用户信息
- **ChannelMembers**：频道成员关系
- **Files**：文件信息
- **Reactions**：表情反应
- **Threads**：线程信息（折叠回复功能）

### 4.3 存储流程

#### 步骤 1：开始数据库事务

为了确保数据一致性，帖子创建过程在数据库事务中执行。

#### 步骤 2：插入主帖子记录

将帖子数据插入 `Posts` 表。

#### 步骤 3：处理相关数据

1. **文件附件**：如果帖子包含文件，更新文件的帖子关联
2. **@提及**：记录提及的用户关系
3. **话题标签**：记录话题标签
4. **线程更新**：如果是回复，更新根帖子的回复计数

#### 步骤 4：提交事务

所有操作成功后，提交事务；否则回滚。

### 4.4 索引策略

为了优化查询性能，Mattermost 对关键字段建立了索引：

- `idx_posts_channel_id`：按频道 ID 索引（查询频道内消息）
- `idx_posts_user_id`：按用户 ID 索引（查询用户发送的消息）
- `idx_posts_root_id`：按根帖子 ID 索引（查询回复）
- `idx_posts_create_at`：按创建时间索引（时间范围查询）
- `idx_posts_channel_id_update_at`：组合索引（频道内按更新时间排序）

---

## 5. WebSocket 广播机制

### 5.1 WebSocket 基础

#### 连接端点

- **URL**：`/api/v4/websocket`
- **协议**：WebSocket（基于 HTTP 升级）

#### 认证方式

WebSocket 连接支持多种认证方式：
1. **Cookie 认证**：浏览器环境自动使用登录 Cookie
2. **Authorization Header**：使用 Bearer Token
3. **认证挑战**：连接后发送认证消息

### 5.2 WebSocket 事件系统

#### 事件格式

所有 WebSocket 事件遵循统一的 JSON 格式：

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

#### 关键字段说明

- **event**：事件类型，如 `posted`、`post_edited`、`post_deleted` 等
- **data**：事件数据，包含具体的业务信息
  - `post`：JSON 编码的帖子对象字符串
  - `mentions`：JSON 编码的提及用户 ID 列表
  - `channel_*`：频道相关信息
- **broadcast**：广播范围控制
  - `channel_id`：指定广播到某个频道的所有成员
  - `user_id`：指定广播到某个特定用户
  - `team_id`：指定广播到某个团队
  - `omit_users`：排除某些用户
- **seq**：事件序列号，用于顺序保证

#### 主要事件类型

| 事件类型 | 描述 |
|----------|------|
| `posted` | 新消息发布 |
| `post_edited` | 消息被编辑 |
| `post_deleted` | 消息被删除 |
| `typing` | 用户正在输入 |
| `reaction_added` | 添加表情反应 |
| `reaction_removed` | 移除表情反应 |
| `channel_updated` | 频道信息更新 |
| `user_added` | 用户被添加到频道 |
| `user_removed` | 用户从频道移除 |
| `status_change` | 用户状态变化 |

### 5.3 新消息广播流程

当服务端成功创建一个新帖子后，会通过 WebSocket 向相关用户广播 `posted` 事件。

#### 步骤 1：确定广播范围

根据帖子的属性确定需要广播的用户范围：

1. **频道成员**：所有当前频道的在线成员
2. **提及用户**：消息中 @提及的用户（即使不在当前频道视图）
3. **排除发送者**：通常不需要向发送者自己广播（他们已经通过 API 响应知道消息发送成功）

#### 步骤 2：构建事件数据

1. **序列化帖子**：将帖子对象序列化为 JSON 字符串
2. **提取提及**：提取消息中 @提及的用户 ID 列表
3. **添加频道信息**：频道名称、显示名称、类型等
4. **添加发送者信息**：发送者用户名

#### 步骤 3：执行广播

通过 WebSocket 连接管理器执行广播：

1. **获取频道连接**：从连接管理器获取当前频道的所有活跃 WebSocket 连接
2. **过滤连接**：根据 `broadcast` 字段过滤需要发送的连接
3. **发送事件**：向每个符合条件的连接发送 WebSocket 消息
4. **处理失败**：如果发送失败，标记连接为待清理

### 5.4 客户端接收和处理

#### 步骤 1：接收 WebSocket 事件

客户端的 WebSocket 管理器持续监听服务端发送的事件。

#### 步骤 2：解析事件数据

1. **解析外层 JSON**：获取 `event`、`data`、`broadcast` 等字段
2. **解析嵌套 JSON**：
   - `data.post`：JSON 字符串，需要再次解析为帖子对象
   - `data.mentions`：JSON 字符串，需要解析为用户 ID 数组

#### 步骤 3：分发事件处理

根据事件类型调用对应的处理函数：

```typescript
// 简化的事件处理逻辑
switch (event.event) {
    case 'posted':
        handlePostEvent(event.data);
        break;
    case 'post_edited':
        handlePostEditedEvent(event.data);
        break;
    case 'post_deleted':
        handlePostDeletedEvent(event.data);
        break;
    // ... 其他事件
}
```

#### 步骤 4：更新 UI

对于 `posted` 事件：

1. **检查是否已存在**：如果是自己发送的消息，可能已经通过 API 响应添加到了 store
2. **添加到 Redux Store**：通过 `RECEIVED_POST` 或 `RECEIVED_NEW_POST` action
3. **更新频道视图**：如果当前用户正在查看该频道，立即显示新消息
4. **更新未读计数**：增加频道的未读消息计数
5. **触发通知**：
   - **浏览器通知**：如果用户不在当前标签页，显示浏览器通知
   - **声音提示**：播放新消息提示音
   - **任务栏闪烁**：桌面客户端的任务栏图标闪烁

---

## 6. 完整消息流程总结

### 6.1 时序图

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│  前端客户端  │         │  API 层   │         │  App 层   │         │  存储层   │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                    │                    │                    │
     │  1. 用户点击发送      │                    │                    │
     │                    │                    │                    │
     │  2. 创建本地临时帖子    │                    │                    │
     │                    │                    │                    │
     │  3. 发送 POST /api/v4/posts │                    │                    │
     │───────────────────>│                    │                    │
     │                    │                    │                    │
     │                    │  4. 解析请求，验证参数   │                    │
     │                    │                    │                    │
     │                    │  5. 调用 App 层         │───────────────────>│
     │                    │                    │                    │
     │                    │                    │  6. 业务逻辑处理       │
     │                    │                    │  - 清理消息           │
     │                    │                    │  - 验证权限           │
     │                    │                    │  - 处理 @提及         │
     │                    │                    │                    │
     │                    │                    │  7. 存储帖子           │───────────────────>│
     │                    │                    │                    │  8. 数据库操作
     │                    │                    │                    │  - 插入 Posts 表
     │                    │                    │                    │  - 更新相关表
     │                    │                    │                    │  - 提交事务
     │                    │                    │<───────────────────│
     │                    │                    │                    │
     │                    │                    │  9. 后续处理           │
     │                    │                    │  - 更新频道统计       │
     │                    │                    │  - 触发插件钩子       │
     │                    │                    │  - 准备 WebSocket 事件 │
     │                    │                    │                    │
     │<───────────────────│<───────────────────│                    │
     │  10. 返回 API 响应   │                    │                    │
     │                    │                    │                    │
     │  11. 更新本地帖子状态  │                    │                    │
     │                    │                    │                    │
     │                    │                    │  12. WebSocket 广播    │
     │                    │                    │  - 获取频道连接        │
     │                    │                    │  - 发送 posted 事件    │
     │<═════════════════════════════════════════│                    │
     │                    │                    │                    │
     │  13. 接收 WebSocket 事件 │                    │                    │
     │                    │                    │                    │
     │  14. 解析事件数据       │                    │                    │
     │                    │                    │                    │
     │  15. 更新 Redux Store  │                    │                    │
     │                    │                    │                    │
     │  16. 更新 UI，显示新消息 │                    │                    │
     │                    │                    │                    │
┌────┴─────┐         ┌────┴─────┐         ┌────┴─────┐         ┌────┴─────┐
│  其他客户端  │         │  API 层   │         │  App 层   │         │  存储层   │
└──────────┘         └──────────┘         └──────────┘         └──────────┘
     │                    │                    │                    │
     │<═════════════════════════════════════════│                    │
     │  17. 接收 WebSocket 广播                   │                    │
     │                    │                    │                    │
     │  18. 处理事件，更新 UI                     │                    │                    │
     │                    │                    │                    │
```

### 6.2 详细步骤说明

#### 阶段 1：前端提交（步骤 1-3）

1. **用户操作**：用户在输入框中输入消息，点击发送按钮或按 Enter 键
2. **本地优化**：前端立即创建一个临时帖子对象，更新 Redux Store，让用户在 UI 上立即看到消息
3. **网络请求**：前端通过 `Client4.createPost` 方法发送 `POST /api/v4/posts` 请求到服务端

#### 阶段 2：API 层处理（步骤 4-5）

4. **请求解析**：API 层接收 HTTP 请求，解析 JSON body，验证必要参数
5. **权限检查**：验证用户身份和权限，确保用户有权在该频道发送消息
6. **委托处理**：将请求委托给 App 层的 `CreatePost` 方法

#### 阶段 3：App 层业务逻辑（步骤 6-9）

7. **业务处理**：
   - 清理和验证消息内容
   - 检查频道状态和用户权限
   - 解析消息中的 @提及、#话题、链接等
   - 生成帖子的唯一 ID 和元数据
8. **数据存储**：调用 Store 层将帖子保存到数据库
9. **后续操作**：
   - 更新频道和用户的统计信息
   - 触发插件的生命周期钩子
   - 准备 WebSocket 广播事件

#### 阶段 4：存储层操作（步骤 8）

10. **数据库事务**：在事务中执行所有数据库操作
11. **插入数据**：
    - 向 `Posts` 表插入新帖子记录
    - 更新相关表（如 `Files`、`Reactions` 等）
    - 更新频道的消息计数
12. **提交事务**：所有操作成功后提交事务

#### 阶段 5：API 响应（步骤 10）

13. **构建响应**：API 层将 App 层返回的帖子对象序列化为 JSON
14. **发送响应**：向客户端返回 201 Created 响应，包含完整的帖子信息

#### 阶段 6：前端处理响应（步骤 11）

15. **更新状态**：前端收到 API 响应，将临时帖子替换为服务端返回的正式帖子
16. **UI 同步**：更新 Redux Store，刷新 UI 显示

#### 阶段 7：WebSocket 广播（步骤 12）

17. **构建事件**：App 层构建 `posted` WebSocket 事件，包含帖子数据和广播范围
18. **执行广播**：WebSocket 管理器向频道内所有在线成员的连接发送事件
19. **异常处理**：处理发送失败的连接，标记为待清理

#### 阶段 8：其他客户端接收（步骤 17-18）

20. **接收事件**：其他在线客户端的 WebSocket 连接收到 `posted` 事件
21. **解析数据**：解析事件 JSON，提取帖子信息
22. **更新状态**：将新帖子添加到 Redux Store
23. **UI 更新**：
    - 如果用户正在查看该频道，立即显示新消息
    - 更新频道的未读计数
    - 触发通知（浏览器通知、声音提示等）

---

## 7. 关键组件协作

### 7.1 前端组件协作

| 组件 | 职责 | 文件位置 |
|------|------|----------|
| `createPost` Action | 消息发送的入口点，管理本地状态和 API 调用 | `webapp/channels/src/packages/mattermost-redux/src/actions/posts.ts` |
| `Client4.createPost` | 封装 HTTP 请求，发送到 `/api/v4/posts` | `webapp/platform/client/src/client4.ts` |
| Post Reducer | 处理帖子相关的 Redux action，更新 store | `webapp/channels/src/packages/mattermost-redux/src/reducers/` |
| WebSocket Manager | 管理 WebSocket 连接，接收和分发事件 | `webapp/channels/src/actions/websocket_actions/` |

### 7.2 服务端组件协作

| 组件 | 职责 | 典型位置 |
|------|------|----------|
| API Handler | 处理 HTTP 请求，参数验证，响应格式化 | `server/channels/api4/post.go` |
| App Service | 核心业务逻辑，事务管理，权限检查 | `server/channels/app/post.go` |
| Store Layer | 数据访问，数据库操作 | `server/channels/store/sqlstore/post_store.go` |
| WebSocket Hub | 管理 WebSocket 连接，事件广播 | `server/channels/app/web_hub.go` |
| Notification Service | 处理推送通知和邮件通知 | `server/channels/app/notification.go` |

### 7.3 数据流方向

1. **请求流**：前端 → API 层 → App 层 → Store 层 → 数据库
2. **响应流**：数据库 → Store 层 → App 层 → API 层 → 前端
3. **广播流**：App 层 → WebSocket Hub → 所有相关客户端

---

## 8. 优化和特殊处理

### 8.1 前端优化

1. **乐观更新**：发送请求前先更新本地 UI，提供即时反馈
2. **临时 ID**：使用 `pending_post_id` 关联本地临时帖子和服务端正式帖子
3. **失败处理**：如果请求失败，标记帖子为失败状态，允许用户重试
4. **批量操作**：使用 `batchActions` 减少 Redux 更新次数，提高性能

### 8.2 服务端优化

1. **数据库索引**：对常用查询字段建立索引，优化查询性能
2. **连接池**：使用数据库连接池，减少连接开销
3. **异步处理**：
   - WebSocket 广播异步执行，不阻塞 API 响应
   - 推送通知和邮件通知异步发送
4. **缓存策略**：对频繁访问的数据（如用户信息、频道信息）进行缓存

### 8.3 WebSocket 优化

1. **事件节流**：对高频事件（如 `typing`）进行节流，减少网络流量
2. **连接管理**：
   - 心跳检测：定期发送心跳包，检测连接状态
   - 自动重连：客户端检测到连接断开后自动尝试重连
3. **事件合并**：在高并发场景下，可能合并多个事件减少发送次数

### 8.4 特殊场景处理

1. **离线消息**：用户离线期间的消息，在重新连接后通过 REST API 拉取
2. **消息编辑**：编辑消息时，发送 `post_edited` 事件，所有客户端更新对应消息
3. **消息删除**：删除消息时，发送 `post_deleted` 事件，客户端显示"消息已删除"占位符
4. **@提及通知**：对 @提及的用户，即使不在当前频道，也会收到特殊通知
5. **线程回复**：对线程中的回复，除了广播到频道，还会通知线程参与者

---

## 9. 安全考虑

### 9.1 认证和授权

1. **API 认证**：所有 API 请求需要有效的认证令牌（Session Token 或 Personal Access Token）
2. **WebSocket 认证**：WebSocket 连接建立后需要进行认证，未认证的连接会被关闭
3. **权限检查**：
   - 验证用户是否是频道成员
   - 验证用户是否有发送消息的权限
   - 验证用户是否可以访问目标频道

### 9.2 数据验证

1. **输入验证**：对所有用户输入进行严格验证，防止 XSS 和注入攻击
2. **消息长度限制**：限制消息最大长度，防止滥用
3. **文件上传限制**：限制文件类型和大小，防止恶意文件上传

### 9.3 隐私保护

1. **频道可见性**：私有频道的消息只对成员可见
2. **直接消息**：一对一和群组消息只有参与者可见
3. **数据加密**：
   - 传输层：使用 HTTPS 和 WSS 加密数据传输
   - 存储层：敏感数据加密存储

---

## 10. 总结

Mattermost 的消息处理流程是一个精心设计的分布式系统，具有以下特点：

1. **用户体验优先**：前端采用乐观更新策略，提供即时反馈，即使在网络延迟情况下也能保持流畅体验

2. **分层架构清晰**：服务端采用 API 层、App 层、Store 层的分层架构，职责明确，易于维护和扩展

3. **实时通信高效**：基于 WebSocket 的事件系统实现了毫秒级的消息广播，确保频道内成员能够实时看到新消息

4. **可靠性保障**：
   - 数据库事务保证数据一致性
   - 异步处理提高系统响应速度
   - 完善的错误处理和重试机制

5. **安全性**：从认证授权到数据验证，再到传输加密，多层次的安全措施保护用户数据

6. **可扩展性**：
   - 插件系统允许第三方扩展消息处理逻辑
   - 支持集群部署，水平扩展处理能力
   - 模块化设计便于功能扩展

这个流程不仅展示了 Mattermost 作为企业级协作工具的技术实力，也为实时通信应用提供了一个优秀的架构参考。

---

## 参考资料

1. Mattermost 官方文档：https://docs.mattermost.com/
2. Mattermost API 文档：https://developers.mattermost.com/api-documentation/
3. Mattermost GitHub 仓库：https://github.com/mattermost/mattermost
4. Mattermost 应用架构：https://docs.mattermost.com/deployment/application-architecture.html
