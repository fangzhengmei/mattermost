# Mattermost 帖子回复处理机制分析报告

## 1. 概述

本文档深入分析 Mattermost 中帖子回复的完整处理流程，包括从用户发送回复消息、未读计数更新，到跨客户端状态同步的全链路机制。分析基于代码库的实际实现，重点关注数据模型设计、核心处理逻辑和状态同步机制。

## 2. 数据模型设计

### 2.1 Post 数据模型

帖子回复的层级关系主要通过 `Post` 结构体中的两个关键字段维护：

**核心字段定义** (`server/public/model/post.go:114-148`):

```go
type Post struct {
    Id         string `json:"id"`
    RootId     string `json:"root_id"`     // 指向根帖子ID，用于标识线程
    OriginalId string `json:"original_id"` // 原始帖子ID（用于消息转发/编辑）
    
    // 以下为临时字段，发送给客户端时填充
    ReplyCount   int64         `json:"reply_count"`   // 回复数量
    LastReplyAt  int64         `json:"last_reply_at"` // 最后回复时间
    IsFollowing  *bool         `json:"is_following,omitempty"` // 当前用户是否关注该线程
}
```

**字段语义说明**：

| 字段 | 作用 | 示例场景 |
|------|------|----------|
| `RootId` | 标识帖子所属的线程根帖子 | 回复帖子时设置为原始帖子的 ID |
| `ReplyCount` | 该帖子的回复数量（仅用于根帖子） | 客户端显示 "3 条回复" |
| `LastReplyAt` | 最后一条回复的时间戳 | 按最后回复时间排序线程 |
| `IsFollowing` | 当前用户是否关注该线程 | 控制是否接收线程更新通知 |

### 2.2 Thread 数据模型

当帖子有第一条回复时，系统会创建 `Thread` 元数据记录：

**Thread 结构体** (`server/public/model/thread.go:11-35`):

```go
type Thread struct {
    PostId       string      `json:"id"`           // 根帖子ID
    ChannelId    string      `json:"channel_id"`   // 所属频道
    ReplyCount   int64       `json:"reply_count"`  // 回复数量
    LastReplyAt  int64       `json:"last_reply_at"`// 最后回复时间
    Participants StringArray `json:"participants"` // 参与者用户ID列表
    DeleteAt     int64       `json:"delete_at"`    // 删除时间
    TeamId       string      `json:"team_id"`      // 所属团队
}
```

**ThreadMembership 结构体** (`server/public/model/thread.go:101-132`):

```go
type ThreadMembership struct {
    PostId         string `json:"post_id"`      // 根帖子ID
    UserId         string `json:"user_id"`      // 用户ID
    Following      bool   `json:"following"`    // 是否关注该线程
    LastUpdated    int64  `json:"last_update_at"` // 最后更新时间
    LastViewed     int64  `json:"last_view_at"`  // 最后查看时间
    UnreadMentions int64  `json:"unread_mentions"` // 未读提及数
}
```

### 2.3 ChannelUnread 数据模型

频道级别的未读信息通过 `ChannelUnread` 跟踪：

**关键相关字段** (参考 `server/channels/app/channel.go`):

- `MsgCount` - 消息总数
- `MentionCount` - 提及计数
- `LastViewedAt` - 最后查看时间

## 3. 帖子回复处理流程

### 3.1 整体流程图

```
用户发送回复
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                    API 层 (api4/post.go)                    │
│  1. createPost() - 接收 HTTP POST 请求                       │
│  2. 权限检查、参数验证                                        │
│  3. 调用 App 层 CreatePostAsUser()                           │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                    App 层 (app/post.go)                      │
│  1. CreatePostAsUser() - 处理用户上下文                      │
│  2. CreatePost() - 核心创建逻辑                              │
│     ├── 验证 RootId 有效性（检查是否为有效根帖子）            │
│     ├── 保存帖子到数据库                                      │
│     ├── 线程自动关注 (ThreadAutoFollow)                      │
│     └── 调用 handlePostEvents()                              │
│  3. handlePostEvents() - 处理后续事件                        │
│     ├── 发送通知 (SendNotifications)                         │
│     └── 触发 Webhook                                          │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                 通知层 (app/notification.go)                 │
│  1. SendNotifications() - 发送各类通知                       │
│     ├── 更新未读计数                                          │
│     ├── 发送邮件通知                                          │
│     ├── 发送推送通知                                          │
│     └── 发送 WebSocket 事件                                   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 核心代码路径

**API 入口** (`server/channels/api4/post.go:96-181`):

```go
func createPost(c *Context, w http.ResponseWriter, r *http.Request) {
    var post model.Post
    json.NewDecoder(r.Body).Decode(&post)
    
    post.SanitizeInput()
    post.UserId = c.AppContext.Session().UserId
    
    // 调用 App 层创建帖子
    rp, isMemberForPreviews, err := c.App.CreatePostAsUser(
        c.AppContext, 
        c.App.PostWithProxyRemovedFromImageURLs(&post), 
        c.AppContext.Session().Id, 
        setOnlineBool
    )
    // ...
}
```

**帖子创建核心逻辑** (`server/channels/app/post.go:162-489`):

```go
func (a *App) CreatePost(rctx request.CTX, post *model.Post, 
    channel *model.Channel, flags model.CreatePostFlags) (
    savedPost *model.Post, isMemberForPreviews bool, err *model.AppError) {
    
    // 1. 如果是回复帖子，验证 RootId 有效性
    var pchan chan store.StoreResult[*model.PostList]
    if post.RootId != "" {
        pchan = make(chan store.StoreResult[*model.PostList], 1)
        go func() {
            // 异步获取父帖子列表进行验证
            r, pErr := a.Srv().Store().Post().Get(
                RequestContextWithMaster(rctx), 
                post.RootId, 
                model.GetPostsOptions{}, 
                "", 
                a.Config().GetSanitizeOptions()
            )
            pchan <- store.StoreResult[*model.PostList]{Data: r, NErr: pErr}
            close(pchan)
        }()
    }
    
    // 2. 等待并验证父帖子
    if pchan != nil {
        result := <-pchan
        parentPostList = result.Data
        
        // 验证：根帖子必须在同一频道
        if !parentPostList.IsChannelId(post.ChannelId) {
            return nil, false, model.NewAppError(
                "createPost", 
                "api.post.create_post.channel_root_id.app_error", 
                nil, "", http.StatusInternalServerError
            )
        }
        
        // 验证：不能对回复再进行回复（RootId 必须指向真正的根帖子）
        rootPost := parentPostList.Posts[post.RootId]
        if rootPost.RootId != "" {
            return nil, false, model.NewAppError(
                "createPost", 
                "api.post.create_post.root_id.app_error", 
                nil, "", http.StatusBadRequest
            )
        }
    }
    
    // 3. 保存帖子到数据库
    rpost, nErr := a.Srv().Store().Post().Save(rctx, post)
    
    // 4. 如果是回复且启用 ThreadAutoFollow，自动关注线程
    if *a.Config().ServiceSettings.ThreadAutoFollow && rpost.RootId != "" {
        _, err := a.Srv().Store().Thread().MaintainMembership(
            user.Id, 
            rpost.RootId, 
            store.ThreadMembershipOpts{
                Following:       true,
                UpdateFollowing: true,
            }
        )
        // ...
    }
    
    // 5. 处理后续事件（通知、WebSocket）
    a.handlePostEvents(rctx, rpost, user, channel, 
        flags.TriggerWebhooks, parentPostList, flags.SetOnline)
    
    return rpost, isMemberForPreviews, nil
}
```

### 3.3 RootId 验证逻辑

**关键验证点** (`server/channels/app/post.go:275-295`):

1. **频道一致性验证**：回复帖子必须与根帖子在同一频道
   ```go
   if !parentPostList.IsChannelId(post.ChannelId) {
       return error
   }
   ```

2. **层级深度验证**：不允许嵌套回复（回复的回复）
   ```go
   rootPost := parentPostList.Posts[post.RootId]
   if rootPost.RootId != "" {
       // 根帖子不能有自己的 RootId，否则是无效的
       return error
   }
   ```

这意味着 Mattermost 采用的是**扁平线程模型**：
- 所有回复都直接链接到根帖子
- 不支持回复特定的回复（嵌套回复）
- 简化了 UI 展示和状态管理

## 4. 未读计数更新机制

### 4.1 双轨未读跟踪系统

Mattermost 维护两套独立的未读计数系统：

| 系统 | 数据结构 | 跟踪粒度 | 适用场景 |
|------|----------|----------|----------|
| **频道未读** | `ChannelMembership` | 频道级别 | 传统视图、频道列表 |
| **线程未读** | `ThreadMembership` | 线程级别 | 折叠回复视图 (CRT) |

### 4.2 未读计数更新流程

**核心更新函数** (`server/channels/app/notification.go:342-351`):

```go
// 更新频道级别的提及计数
nErr := a.Srv().Store().Channel().IncrementMentionCount(
    post.ChannelId, 
    mentionedUsersList, 
    post.RootId == "",  // 是否为根帖子
    post.IsUrgent()      // 是否为紧急帖子
)
```

**线程成员维护** (`server/channels/app/notification.go:303-319`):

```go
opts := store.ThreadMembershipOpts{
    Following:             true,              // 设置为关注
    IncrementMentions:     incrementMentions, // 是否增加提及计数
    UpdateFollowing:       updateFollowing,   // 是否更新关注状态
    UpdateViewedTimestamp: false,             // 不更新查看时间
    UpdateParticipants:    userID == post.UserId, // 更新参与者列表
}

threadMembership, err := a.Srv().Store().Thread().MaintainMembership(
    userID, 
    post.RootId, 
    opts
)
```

### 4.3 通知处理中的未读更新

**SendNotifications 函数流程** (`server/channels/app/notification.go:54-896`):

```go
func (a *App) SendNotifications(...) {
    // 1. 并行获取所需数据
    //    - 频道所有用户资料
    //    - 频道成员通知设置
    //    - 线程关注者（如果是回复）
    //    - 允许的群组提及
    
    // 2. 解析提及和关键词
    mentions, keywords := a.getExplicitMentionsAndKeywords(...)
    
    // 3. 线程自动关注处理（如果启用）
    if *a.Config().ServiceSettings.ThreadAutoFollow && post.RootId != "" {
        // 为所有参与者维护线程成员关系
        for id := range threadParticipants {
            go func(userID string) {
                opts := store.ThreadMembershipOpts{
                    Following:         true,
                    IncrementMentions: mentions.Mentions[userID],
                    // ...
                }
                a.Srv().Store().Thread().MaintainMembership(userID, post.RootId, opts)
            }(id)
        }
    }
    
    // 4. 更新频道提及计数
    a.Srv().Store().Channel().IncrementMentionCount(...)
    
    // 5. 发送各类通知
    //    - 邮件通知
    //    - 推送通知
    //    - WebSocket 事件（关键！）
    
    // 6. 发送帖子 WebSocket 事件
    message := model.NewWebSocketEvent(model.WebsocketEventPosted, "", post.ChannelId, "", nil, "")
    a.publishWebsocketEventForPost(rctx, post, message)
    
    // 7. 如果是回复，发送线程更新事件给关注者
    if isCRTAllowed && post.RootId != "" {
        for uid := range followers {
            if a.IsCRTEnabledForUser(rctx, uid) {
                // 为每个 CRT 用户发送独立的 thread_updated 事件
                message := model.NewWebSocketEvent(
                    model.WebsocketEventThreadUpdated, 
                    team.Id, "", uid, nil, ""
                )
                
                // 获取用户特定的线程数据（包含未读计数）
                userThread, err := a.Srv().Store().Thread().GetThreadForUser(
                    rctx, threadMembership, true, a.IsPostPriorityEnabled()
                )
                
                // 计算之前的未读数（用于客户端增量更新）
                previousUnreadMentions := int64(0)
                previousUnreadReplies := int64(0)
                if !newParticipants[uid] {
                    previousUnreadMentions = userThread.UnreadMentions
                    previousUnreadReplies = max(userThread.UnreadReplies-1, 0)
                }
                
                // 发送事件
                message.Add("thread", string(payload))
                message.Add("previous_unread_mentions", previousUnreadMentions)
                message.Add("previous_unread_replies", previousUnreadReplies)
                a.Publish(message)
            }
        }
    }
}
```

### 4.4 未读状态计算

**ThreadResponse 中的未读字段** (`server/public/model/thread.go:37-48`):

```go
type ThreadResponse struct {
    PostId         string  `json:"id"`
    UnreadReplies  int64   `json:"unread_replies"`  // 未读回复数
    UnreadMentions int64   `json:"unread_mentions"` // 未读提及数
    LastViewedAt   int64   `json:"last_viewed_at"`  // 最后查看时间
    // ...
}
```

**未读回复数计算逻辑**：
```
UnreadReplies = 线程总回复数 - 上次查看时的回复数
```
或者基于时间戳：
```
UnreadReplies = （LastReplyAt > LastViewedAt）期间的回复数
```

## 5. 跨客户端状态同步机制

### 5.1 WebSocket 事件系统

**核心事件类型定义** (`server/public/model/websocket_message.go:15-117`):

```go
const (
    // 帖子相关事件
    WebsocketEventPosted         WebsocketEventType = "posted"          // 新帖子
    WebsocketEventPostEdited     WebsocketEventType = "post_edited"     // 帖子编辑
    WebsocketEventPostDeleted    WebsocketEventType = "post_deleted"    // 帖子删除
    WebsocketEventPostUnread     WebsocketEventType = "post_unread"     // 标记为未读
    
    // 线程相关事件（CRT 专用）
    WebsocketEventThreadUpdated      WebsocketEventType = "thread_updated"      // 线程更新
    WebsocketEventThreadFollowChanged WebsocketEventType = "thread_follow_changed" // 关注状态变化
    WebsocketEventThreadReadChanged   WebsocketEventType = "thread_read_changed"   // 阅读状态变化
    
    // 频道成员更新（包含未读计数）
    WebsocketEventChannelMemberUpdated WebsocketEventType = "channel_member_updated"
)
```

### 5.2 posted 事件广播

**事件创建** (`server/channels/app/notification.go:679-724`):

```go
message := model.NewWebSocketEvent(model.WebsocketEventPosted, "", post.ChannelId, "", nil, "")

// 添加事件数据
message.Add("channel_type", channel.Type)
message.Add("channel_display_name", notification.GetChannelName(...))
message.Add("channel_name", channel.Name)
message.Add("sender_name", notification.GetSenderName(...))
message.Add("team_id", team.Id)
message.Add("set_online", setOnline)

// 添加提及用户钩子（用于权限过滤）
if len(mentionedUsersList) > 0 {
    useAddMentionsHook(message, mentionedUsersList)
}

// 添加线程关注者钩子
if len(notificationsForCRT.Desktop) > 0 {
    useAddFollowersHook(message, notificationsForCRT.Desktop)
}

// 发布事件
a.publishWebsocketEventForPost(rctx, post, message)
```

### 5.3 thread_updated 事件（用户特定）

与 `posted` 事件不同，`thread_updated` 事件是**针对每个用户单独发送**的，因为每个用户的未读状态不同：

**事件发送逻辑** (`server/channels/app/notification.go:740-886`):

```go
if isCRTAllowed && post.RootId != "" {
    for uid := range followers {
        if a.IsCRTEnabledForUser(rctx, uid) {
            // 1. 为每个用户创建独立事件
            message := model.NewWebSocketEvent(
                model.WebsocketEventThreadUpdated, 
                team.Id, 
                "",      // 不指定频道
                uid,     // 只发送给特定用户
                nil, ""
            )
            
            // 2. 获取用户特定的线程数据
            userThread, err := a.Srv().Store().Thread().GetThreadForUser(
                rctx, threadMembership, true, a.IsPostPriorityEnabled()
            )
            
            // 3. 计算增量值（客户端用于动画和计数更新）
            previousUnreadMentions := int64(0)
            previousUnreadReplies := int64(0)
            
            if !newParticipants[uid] {
                // 不是新参与者，计算之前的未读数
                previousUnreadMentions = userThread.UnreadMentions
                previousUnreadReplies = max(userThread.UnreadReplies-1, 0)
                
                if mentions.isUserMentioned(uid) {
                    previousUnreadMentions = max(userThread.UnreadMentions-1, 0)
                }
            }
            
            // 4. 发送者自己查看后应该清零未读
            if uid == post.UserId {
                opts := store.ThreadMembershipOpts{
                    UpdateViewedTimestamp: true,
                }
                a.Srv().Store().Thread().MaintainMembership(uid, post.RootId, opts)
                userThread.UnreadMentions = 0
                userThread.UnreadReplies = 0
            }
            
            // 5. 序列化并发送
            payload, _ := json.Marshal(userThread)
            message.Add("thread", string(payload))
            message.Add("previous_unread_mentions", previousUnreadMentions)
            message.Add("previous_unread_replies", previousUnreadReplies)
            
            a.Publish(message)
        }
    }
}
```

### 5.4 WebSocket 广播机制

**广播目标控制** (`server/public/model/websocket_message.go:139-162`):

```go
type WebsocketBroadcast struct {
    OmitUsers        map[string]bool `json:"omit_users"`   // 排除这些用户
    UserId           string          `json:"user_id"`      // 只发给这个用户
    ChannelId        string          `json:"channel_id"`   // 只发给这个频道的成员
    TeamId           string          `json:"team_id"`      // 只发给这个团队的成员
    ConnectionId     string          `json:"connection_id"`// 只发给这个连接
    OmitConnectionId string          `json:"omit_connection_id"` // 排除这个连接
    // ...
}
```

**事件发送策略对比**：

| 事件类型 | 广播范围 | 数据内容 | 使用场景 |
|----------|----------|----------|----------|
| `posted` | 频道所有成员 | 通用帖子数据 | 新帖子通知、实时聊天 |
| `thread_updated` | 单个用户 | 用户特定未读计数 | CRT 视图线程更新 |
| `channel_member_updated` | 单个用户 | 频道未读状态 | 标记已读/未读后 |

### 5.5 客户端状态同步策略

**客户端接收事件后应执行的操作**：

1. **posted 事件**：
   - 将新帖子添加到本地存储
   - 如果是当前频道，更新 UI
   - 更新频道未读计数（如果不是发送者）

2. **thread_updated 事件**：
   - 使用 `previous_unread_*` 字段计算增量
   - 更新本地线程未读计数
   - 更新全局未读计数总和
   - 如果是当前查看的线程，可能需要刷新

3. **channel_member_updated 事件**：
   - 完全替换本地频道成员数据
   - 更新频道列表的未读指示器

**增量更新设计**：

服务器在 `thread_updated` 事件中发送 `previous_unread_mentions` 和 `previous_unread_replies`，允许客户端：
- 计算变化量：`delta = current - previous`
- 执行平滑的 UI 动画（如数字跳动）
- 避免完全重新获取数据

### 5.6 标记已读机制

**用户查看帖子后更新未读状态**的核心逻辑：

当用户查看频道或线程时，系统需要：
1. 更新 `ChannelMembership.LastViewedAt`
2. 更新 `ThreadMembership.LastViewed`
3. 重置相应的未读计数
4. 发送 `channel_member_updated` 或 `thread_read_changed` 事件

**相关 API 端点** (`server/channels/api4/post.go:1244-1269`):

```go
func setPostUnread(c *Context, w http.ResponseWriter, r *http.Request) {
    // 调用 App 层标记为未读
    state, err := c.App.MarkChannelAsUnreadFromPost(
        c.AppContext, 
        c.Params.PostId, 
        c.Params.UserId, 
        collapsedThreadsSupported
    )
    // 返回更新后的状态
}
```

## 6. 线程关注机制

### 6.1 自动关注规则

**ThreadAutoFollow 配置** (`server/channels/app/notification.go:244-337`):

当 `ServiceSettings.ThreadAutoFollow` 为 `true` 时，以下情况会自动关注线程：

1. **回复帖子的用户**：回复后自动关注自己参与的线程
2. **被提及的用户**：在帖子中被 @ 提及的用户
3. **根帖子作者**（如果不是来自 webhook）
4. **之前被提及的用户**：在之前的回复中被提及的
5. **启用频道自动关注的用户**：`channel_auto_follow_threads` 设置为 `true`

### 6.2 关注状态维护

**MaintainMembership 函数**（参考 `server/channels/store/sqlstore/thread_store.go`）:

这是一个幂等操作，用于创建或更新线程成员关系：

```go
type ThreadMembershipOpts struct {
    Following             bool // 新的关注状态
    IncrementMentions     bool // 是否增加未读提及数
    UpdateFollowing       bool // 是否更新关注状态
    UpdateViewedTimestamp bool // 是否更新最后查看时间
    UpdateParticipants    bool // 是否更新参与者列表
}
```

### 6.3 关注状态变更事件

当用户手动关注/取消关注线程时，发送：

```go
WebsocketEventThreadFollowChanged // "thread_follow_changed"
```

## 7. 关键代码位置索引

### 7.1 数据模型层

| 功能 | 文件路径 | 关键行号 |
|------|----------|----------|
| Post 结构体 | `server/public/model/post.go` | 114-148 |
| Thread 结构体 | `server/public/model/thread.go` | 11-35 |
| ThreadMembership 结构体 | `server/public/model/thread.go` | 101-132 |
| WebSocket 事件类型 | `server/public/model/websocket_message.go` | 15-117 |

### 7.2 API 层

| 功能 | 文件路径 | 关键行号 |
|------|----------|----------|
| 创建帖子 | `server/channels/api4/post.go` | 96-181 |
| 获取帖子线程 | `server/channels/api4/post.go` | 780-918 |
| 标记帖子未读 | `server/channels/api4/post.go` | 1244-1269 |

### 7.3 App 层

| 功能 | 文件路径 | 关键行号 |
|------|----------|----------|
| 创建帖子核心逻辑 | `server/channels/app/post.go` | 162-489 |
| RootId 验证 | `server/channels/app/post.go` | 275-295 |
| 处理帖子事件 | `server/channels/app/post.go` | 643-691 |
| 发送通知 | `server/channels/app/notification.go` | 54-896 |
| 更新提及计数 | `server/channels/app/notification.go` | 342-351 |
| 线程自动关注 | `server/channels/app/notification.go` | 244-337 |
| 发送 thread_updated 事件 | `server/channels/app/notification.go` | 740-886 |

### 7.4 存储层

| 功能 | 文件路径 |
|------|----------|
| 帖子存储 | `server/channels/store/sqlstore/post_store.go` |
| 线程存储 | `server/channels/store/sqlstore/thread_store.go` |
| 频道存储 | `server/channels/store/sqlstore/channel_store.go` |

## 8. 架构总结

### 8.1 设计亮点

1. **扁平线程模型**：通过 `RootId` 实现简单的线程层级，避免复杂的嵌套回复
2. **双轨未读跟踪**：频道级别和线程级别独立跟踪，支持传统视图和 CRT 视图
3. **用户特定事件**：`thread_updated` 事件针对每个用户单独发送，确保未读状态准确
4. **增量更新设计**：发送 `previous_unread_*` 字段让客户端可以平滑更新 UI
5. **广播钩子机制**：通过 `BroadcastHooks` 在发送前动态过滤接收者

### 8.2 数据流概览

```
┌─────────────┐     HTTP POST      ┌─────────────┐
│   客户端A   │ ─────────────────→ │  API Layer  │
│  (发送回复) │                    │             │
└─────────────┘                    └──────┬──────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │  App Layer  │
                                   │  CreatePost │
                                   └──────┬──────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                    ▼                     ▼                     ▼
              ┌──────────┐       ┌──────────────┐      ┌───────────────┐
              │  数据库  │       │ 未读计数更新 │      │  WebSocket    │
              │  持久化  │       │              │      │   事件发送    │
              └──────────┘       └──────────────┘      └───────┬───────┘
                                                                 │
                    ┌────────────────────────────────────────────┤
                    │                                            │
                    ▼                                            ▼
           ┌─────────────────┐                        ┌─────────────────┐
           │   posted 事件   │                        │ thread_updated  │
           │  (频道广播)     │                        │  (用户单播)     │
           └────────┬────────┘                        └────────┬────────┘
                    │                                            │
                    ▼                                            ▼
           ┌─────────────────┐                        ┌─────────────────┐
           │  所有频道成员   │                        │  线程关注者     │
           │  (客户端B/C/D)  │                        │  (客户端B/C)    │
           └─────────────────┘                        └─────────────────┘
```

### 8.3 关键配置项

| 配置项 | 位置 | 作用 |
|--------|------|------|
| `CollapsedThreads` | `ServiceSettings` | 控制全局/按用户启用折叠回复 |
| `ThreadAutoFollow` | `ServiceSettings` | 回复后是否自动关注线程 |
| `MaxNotificationsPerChannel` | `TeamSettings` | 频道成员超过此数时 @channel/@here 不发送通知 |

## 9. 附录

### 9.1 名词解释

- **CRT (Collapsed Reply Threads)**：折叠回复线程，Mattermost 的线程视图功能
- **Root Post**：根帖子，线程中的原始帖子
- **Thread Membership**：线程成员关系，记录用户与线程的关联状态
- **Mention**：提及，通过 @username 通知特定用户
- **Broadcast Hook**：广播钩子，在 WebSocket 事件发送前动态过滤接收者的机制

### 9.2 相关 API 端点

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v4/posts` | POST | 创建帖子（包括回复） |
| `/api/v4/posts/{post_id}/thread` | GET | 获取帖子的完整线程 |
| `/api/v4/users/{user_id}/posts/{post_id}/set_unread` | POST | 标记帖子为未读 |
| `/api/v4/users/{user_id}/threads` | GET | 获取用户的线程列表 |
| `/api/v4/users/{user_id}/threads/{thread_id}/follow` | POST/PUT | 关注/取消关注线程 |
| `/api/v4/users/{user_id}/threads/{thread_id}/read` | PUT | 标记线程为已读 |

---

*分析日期：2026-05-02*
*基于 Mattermost 代码库版本：v8.x*
