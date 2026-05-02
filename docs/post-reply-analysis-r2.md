# Mattermost 未读同步闭环深度分析

## 1. 概述

本文档聚焦未读状态同步闭环，深度分析两条关键链路：

1. **链路 A - 标已读**：用户查看频道或线程后，自动标记为已读
2. **链路 B - 标未读**：用户手动将特定帖子标记为未读

本文档从**入口、状态持久化、事件推送、跨端收敛差异**四个维度进行对比分析，并梳理关键分支条件与时序。

---

## 2. 链路 A：查看频道/线程后标已读

### 2.1 入口分析

#### 2.1.1 API 端点

**核心入口** (`server/channels/api4/channel.go`):

```go
func viewChannel(c *Context, w http.ResponseWriter, r *http.Request) {
    // 调用 App 层的 ViewChannel
}
```

**请求参数** (`model.ChannelView`):

| 参数 | 类型 | 作用 |
|------|------|------|
| `ChannelId` | string | 当前查看的频道 ID |
| `PrevChannelId` | string | 之前查看的频道 ID（用于同时标记两个频道） |

#### 2.1.2 调用链

```
用户切换/进入频道
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  客户端调用 POST /api/v4/channels/members/me/view          │
│  Body: { "channel_id": "xxx", "prev_channel_id": "yyy" }  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  ViewChannel(rctx, view, userID, currentSessionId,         │
│              collapsedThreadsSupported)                      │
│  - 组装 channelIDs = [ChannelId, PrevChannelId]            │
│  - 调用 SetActiveChannel 设置活动频道                         │
│  - 调用 MarkChannelsAsViewed                                 │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  MarkChannelsAsViewed(channelIDs, userID, currentSessionId,│
│                       collapsedThreadsSupported, isCRTEnabled)│
│  - 检查哪些频道需要实际标记（有未读）                          │
│  - 线程级别的标已读（非 CRT 客户端）                          │
│  - 频道级别的标已读                                           │
│  - 发送 WebSocket 事件                                        │
│  - 清除推送通知                                               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 状态持久化分析

#### 2.2.1 前置检查

**检查哪些频道需要标记** (`server/channels/app/channel.go:3340`):

```go
channelsToView, channelsToClearPushNotifications, times, err := 
    a.Srv().Store().Channel().GetChannelsWithUnreadsAndWithMentions(
        rctx, channelIDs, userID, user.NotifyProps
    )
```

**检查逻辑**：
- 只有真正有未读的频道才会进入后续处理
- `channelsToView` - 需要更新 `LastViewedAt` 的频道列表
- `channelsToClearPushNotifications` - 需要清除推送通知的频道

**提前退出条件** (`channel.go:3345-3347`):

```go
if len(channelsToView) == 0 {
    return times, nil  // 没有需要标记的频道，直接返回
}
```

#### 2.2.2 线程级别的标已读（非 CRT 客户端）

**关键分支条件** (`channel.go:3349`):

```go
updateThreads := *a.Config().ServiceSettings.ThreadAutoFollow && 
    (!collapsedThreadsSupported || !isCRTEnabled)
```

| 条件 | 含义 |
|------|------|
| `ThreadAutoFollow = true` | 线程自动关注功能已启用 |
| `!collapsedThreadsSupported` | 客户端不支持折叠回复线程 |
| `!isCRTEnabled` | 用户未启用 CRT |

**当 `updateThreads = true` 时** (`channel.go:3350-3355`):

```go
if updateThreads {
    err = a.Srv().Store().Thread().MarkAllAsReadByChannels(userID, channelsToView)
    // ...
}
```

**数据库操作** (`server/channels/store/sqlstore/thread_store.go:621-642`):

```go
func (s *SqlThreadStore) MarkAllAsReadByChannels(userID string, channelIDs []string) error {
    now := model.GetMillis()
    
    query := s.getQueryBuilder().Update("ThreadMemberships").From("Threads").
        Set("LastViewed", now).                    // 设置最后查看时间为当前时间
        Set("UnreadMentions", 0).                   // 清零未读提及数
        Set("LastUpdated", now).
        Where(sq.Eq{"ThreadMemberships.UserId": userID}).
        Where(sq.Expr("Threads.PostId = ThreadMemberships.PostId")).
        Where(sq.Eq{"Threads.ChannelId": channelIDs}).
        Where(sq.Expr("Threads.LastReplyAt > ThreadMemberships.LastViewed"))  // 只更新有未读的
    
    _, err := s.GetMaster().ExecBuilder(query)
    // ...
}
```

**SQL 逻辑分析**：
- 只更新 `LastReplyAt > LastViewed` 的线程（有未读回复）
- 将 `LastViewed` 设置为当前时间戳
- 将 `UnreadMentions` 清零
- 通过 `Threads` 表关联，根据 `ChannelId` 批量更新

#### 2.2.3 频道级别的标已读

**核心数据库操作** (`server/channels/app/channel.go:3357`):

```go
_, err = a.Srv().Store().Channel().UpdateLastViewedAt(channelsToView, userID)
```

**完整实现** (`server/channels/store/sqlstore/channel_store.go:2548-2604`):

```go
func (s SqlChannelStore) UpdateLastViewedAt(channelIds []string, userId string) (map[string]int64, error) {
    // 使用 CTE (Common Table Expression) 进行批量更新
    // 查询 Channels 获取 LastPostAt, TotalMsgCount, TotalMsgCountRoot
    
    // 更新 ChannelMembers：
    // 1. MentionCount = 0                - 清零提及计数
    // 2. MentionCountRoot = 0            - 清零根帖子提及计数
    // 3. UrgentMentionCount = 0          - 清零紧急提及计数
    // 4. MsgCount = greatest(cm.MsgCount, c.TotalMsgCount)
    //    - 对齐到频道的总消息数（防止计数漂移）
    // 5. MsgCountRoot = greatest(cm.MsgCountRoot, c.TotalMsgCountRoot)
    // 6. LastViewedAt = greatest(cm.LastViewedAt, c.LastPostAt)
    //    - 设置为频道最后一条消息的时间
    // 7. LastUpdateAt = greatest(...)
    
    // 条件：cm.UserId = ? AND c.Id = cm.ChannelId
}
```

**关键设计要点**：

| 字段 | 更新逻辑 | 设计意图 |
|------|----------|----------|
| `MentionCount` | 直接设为 0 | 标记为已读后，所有提及都被"阅读" |
| `MsgCount` | `greatest(current, TotalMsgCount)` | 防止计数漂移，确保对齐到频道实际消息数 |
| `LastViewedAt` | `greatest(current, LastPostAt)` | 设置为频道最新消息时间，表示"已看到最新" |

### 2.3 事件推送分析

#### 2.3.1 事件发送策略

**标记已读后发送的事件** (`server/channels/app/channel.go:3368-3385`):

```go
// 事件 1: MultipleChannelsViewed (仅当 EnableChannelViewedMessages 启用时)
if *a.Config().ServiceSettings.EnableChannelViewedMessages {
    message := model.NewWebSocketEvent(
        model.WebsocketEventMultipleChannelsViewed, 
        "", "", userID, nil, ""
    )
    message.Add("channel_times", times)
    a.Publish(message)
}

// 清除推送通知
for _, channelID := range channelsToClearPushNotifications {
    a.clearPushNotification(currentSessionId, userID, channelID, "")
}

// 事件 2: ThreadReadChanged (仅当 updateThreads && isCRTEnabled 时)
if updateThreads && isCRTEnabled {
    timestamp := model.GetMillis()
    for _, channelID := range channelsToView {
        message := model.NewWebSocketEvent(
            model.WebsocketEventThreadReadChanged, 
            "", channelID, userID, nil, ""
        )
        message.Add("timestamp", timestamp)
        a.Publish(message)
    }
}
```

#### 2.3.2 事件类型详解

| 事件类型 | 触发条件 | 广播目标 | 携带数据 |
|----------|----------|----------|----------|
| `multiple_channels_viewed` | `EnableChannelViewedMessages = true` | 仅当前用户 (`userID`) | `channel_times`: { channelID: lastViewedAt } |
| `thread_read_changed` | `updateThreads = true` AND `isCRTEnabled = true` | 当前用户 + 指定频道 (`channelID`) | `timestamp`: 当前时间 |

#### 2.3.3 广播范围分析

**事件 1: multiple_channels_viewed**

```go
message := model.NewWebSocketEvent(
    model.WebsocketEventMultipleChannelsViewed, 
    "",         // teamId = "" (空)
    "",         // channelId = "" (空)
    userID,     // userId = 当前用户ID
    nil, ""
)
```

**广播目标**：
- **TeamId**: `""` - 不限制团队
- **ChannelId**: `""` - 不限制频道
- **UserId**: `userID` - **只发送给当前用户**的所有连接

**跨端同步**：当前用户的所有设备（Web、桌面、移动端）都会收到此事件。

---

**事件 2: thread_read_changed**

```go
message := model.NewWebSocketEvent(
    model.WebsocketEventThreadReadChanged, 
    "",         // teamId = ""
    channelID,  // channelId = 已读的频道
    userID,     // userId = 当前用户ID
    nil, ""
)
```

**广播目标**：
- **TeamId**: `""` - 不限制团队
- **ChannelId**: `channelID` - 发送给该频道的成员
- **UserId**: `userID` - 但额外限制只发送给当前用户

**注意**：这个事件的条件是 `updateThreads && isCRTEnabled`，这是一个相对少见的组合：
- `updateThreads` 要求 `!collapsedThreadsSupported || !isCRTEnabled`
- 但又要求 `isCRTEnabled`
- 实际触发条件是：`collapsedThreadsSupported = false` 且 `isCRTEnabled = true`

### 2.4 跨端收敛分析

#### 2.4.1 事件驱动的状态同步

**客户端收到事件后的行为**：

| 事件 | 客户端行为 |
|------|------------|
| `multiple_channels_viewed` | - 更新本地 `LastViewedAt`<br>- 清除频道未读计数<br>- 同步到其他设备 |
| `thread_read_changed` | - 更新线程的 `LastViewed` 时间戳<br>- 重置线程未读计数 |

#### 2.4.2 收敛策略

**单源真相**：
- 数据库是唯一的真相源
- 所有客户端都从数据库获取最终状态
- WebSocket 事件用于**增量通知**，而非**状态传输**

**潜在竞争条件**：

```
时间线：
t1: 客户端 A 查看频道 X → 发送标已读请求
t2: 有新回复到达频道 X → 更新未读计数
t3: 标已读操作完成 → 发送 multiple_channels_viewed 事件
t4: 新回复的 posted 事件到达

客户端 B 的处理：
- 先收到 "已读" 事件 → 认为频道已读
- 后收到 "新回复" 事件 → 更新为有 1 条未读
→ 最终状态正确（有新回复）
```

**设计亮点**：
- 使用时间戳 `LastViewedAt` 而非计数差值
- `posted` 事件携带完整的未读状态增量
- 客户端可以通过重新拉取频道列表来"对齐"状态

---

## 3. 链路 B：手动把帖子标未读

### 3.1 入口分析

#### 3.1.1 API 端点

**核心入口** (`server/channels/api4/post.go:1244-1269`):

```go
func setPostUnread(c *Context, w http.ResponseWriter, r *http.Request) {
    // POST /api/v4/users/{user_id}/posts/{post_id}/set_unread
    
    c.RequireUserId()
    c.RequirePostId()
    if c.Err != nil {
        return
    }
    
    // 检查是否是操作自己的未读状态，或有 sysadmin 权限
    if c.AppContext.Session().UserId != c.Params.UserId && 
       !c.AppContext.Session().HasPermissionTo(*c.AppContext.Session().UserId, model.PermissionManageSystem) {
        c.SetPermissionError(model.PermissionManageSystem)
        return
    }
    
    // 调用 App 层
    state, err := c.App.MarkChannelAsUnreadFromPost(
        c.AppContext, 
        c.Params.PostId, 
        c.Params.UserId, 
        c.AppContext.IsCollapsedThreadsSupported()
    )
    // ...
}
```

#### 3.1.2 调用链

```
用户右键帖子选择 "标记为未读"
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  客户端调用 POST /users/{user_id}/posts/{post_id}/set_unread│
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  MarkChannelAsUnreadFromPost(postID, userID,                │
│                              collapsedThreadsSupported)       │
│  - 分支判断：CRT 是否启用                                      │
│  - 获取帖子和用户信息                                          │
│  - 计算从该帖子开始的提及数                                     │
│  - 更新频道未读状态                                            │
│  - 如果是回复帖子，更新线程状态（非 CRT 客户端）                │
│  - 发送 WebSocket 事件                                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 状态持久化分析

#### 3.2.1 核心分支条件

**第一个关键分支** (`server/channels/app/channel.go:3032-3034`):

```go
func (a *App) MarkChannelAsUnreadFromPost(...) {
    if !collapsedThreadsSupported || !a.IsCRTEnabledForUser(rctx, userID) {
        // 非 CRT 客户端或用户未启用 CRT
        return a.markChannelAsUnreadFromPostCRTUnsupported(rctx, postID, userID)
    }
    
    // CRT 启用的情况
    // ...
}
```

**两个实现路径**：

| 路径 | 触发条件 | 特点 |
|------|----------|------|
| `MarkChannelAsUnreadFromPost` (CRT 启用) | `collapsedThreadsSupported = true` AND `IsCRTEnabled = true` | 简化逻辑，只处理频道级 |
| `markChannelAsUnreadFromPostCRTUnsupported` | 其他情况 | 完整逻辑，处理频道 + 线程级 |

#### 3.2.2 CRT 启用的情况（简化路径）

**代码** (`channel.go:3031-3060`):

```go
func (a *App) MarkChannelAsUnreadFromPost(...) {
    // 1. 获取帖子
    post, err := a.GetSinglePost(rctx, postID, false)
    
    // 2. 获取用户
    user, err := a.GetUser(userID)
    
    // 3. 计算从该帖子开始的提及数
    unreadMentions, unreadMentionsRoot, urgentMentions, err := 
        a.countMentionsFromPost(rctx, user, post)
    
    // 4. 更新频道未读状态
    //    setUnreadCountRoot = true (CRT 启用时，区分根帖子和回复)
    channelUnread, nErr := a.Srv().Store().Channel().UpdateLastViewedAtPost(
        post, userID, unreadMentions, unreadMentionsRoot, urgentMentions, true
    )
    
    // 5. 发送 post_unread 事件
    a.sendWebSocketPostUnreadEvent(rctx, channelUnread, postID)
    a.UpdateMobileAppBadge(userID)
    
    return channelUnread, nil
}
```

#### 3.2.3 CRT 未启用的情况（完整路径）

**代码** (`channel.go:3062-3168`):

```go
func (a *App) markChannelAsUnreadFromPostCRTUnsupported(...) {
    // 1. 获取帖子
    post, appErr := a.GetSinglePost(rctx, postID, false)
    
    // 2. 获取用户
    user, appErr := a.GetUser(userID)
    
    // 3. 确定线程 ID
    threadId := post.RootId
    if post.RootId == "" {
        threadId = post.Id  // 根帖子的线程 ID 是自己
    }
    
    // 4. 计算提及数
    unreadMentions, unreadMentionsRoot, urgentMentions, appErr := 
        a.countMentionsFromPost(rctx, user, post)
    
    // ========== 分支：是根帖子还是回复？ ==========
    
    if post.RootId == "" {
        // ===== 情况 A：标记的是根帖子 =====
        
        // 更新频道未读状态
        // setUnreadCountRoot = true
        channelUnread, nErr := a.Srv().Store().Channel().UpdateLastViewedAtPost(
            post, userID, unreadMentions, unreadMentionsRoot, urgentMentions, true
        )
        
        // 发送事件
        a.sendWebSocketPostUnreadEvent(rctx, channelUnread, postID)
        a.UpdateMobileAppBadge(userID)
        return channelUnread, nil
    }
    
    // ===== 情况 B：标记的是回复帖子 =====
    
    // 获取根帖子
    rootPost, appErr := a.GetSinglePost(rctx, post.RootId, false)
    
    // 获取频道
    channel, nErr := a.Srv().Store().Channel().Get(post.ChannelId, true)
    
    // ========== 子分支：ThreadAutoFollow 是否启用？ ==========
    
    if *a.Config().ServiceSettings.ThreadAutoFollow {
        // 确保用户关注该线程
        threadMembership, mErr := a.Srv().Store().Thread().GetMembershipForUser(user.Id, threadId)
        
        var errNotFound *store.ErrNotFound
        if mErr != nil && !errors.As(mErr, &errNotFound) {
            // 错误处理
        }
        
        if threadMembership == nil {
            // 还没有关注，创建成员关系
            opts := store.ThreadMembershipOpts{
                Following:             true,
                IncrementMentions:     false,
                UpdateFollowing:       true,
                UpdateViewedTimestamp: false,
                UpdateParticipants:    false,
            }
            threadMembership, mErr = a.Srv().Store().Thread().MaintainMembership(
                user.Id, threadId, opts
            )
        }
        
        // 更新线程成员关系
        threadMembership.Following = true
        // 设置 LastViewed = 帖子创建时间 - 1（表示该帖子之后都是未读）
        threadMembership.LastViewed = post.CreateAt - 1
        // 计算线程内的未读提及数
        threadMembership.UnreadMentions, appErr = a.countThreadMentions(
            rctx, user, rootPost, channel.TeamId, post.CreateAt-1
        )
        
        // 保存更新
        threadMembership, mErr = a.Srv().Store().Thread().UpdateMembership(threadMembership)
        
        // 如果用户启用了 CRT，发送 thread_updated 事件
        if a.IsCRTEnabledForUser(rctx, userID) {
            // 获取用户特定的线程数据
            thread, mErr := a.Srv().Store().Thread().GetThreadForUser(
                rctx, threadMembership, true, a.IsPostPriorityEnabled()
            )
            
            // 序列化并发送事件
            payload, jsonErr := json.Marshal(thread)
            message := model.NewWebSocketEvent(
                model.WebsocketEventThreadUpdated, 
                channel.TeamId, "", userID, nil, ""
            )
            message.Add("thread", string(payload))
            a.Publish(message)
        }
    }
    
    // 最后，更新频道级别的未读状态
    // setUnreadCountRoot = false (非 CRT 客户端，不区分根帖子)
    channelUnread, nErr := a.Srv().Store().Channel().UpdateLastViewedAtPost(
        post, userID, unreadMentions, 0, 0, false
    )
    
    a.sendWebSocketPostUnreadEvent(rctx, channelUnread, postID)
    a.UpdateMobileAppBadge(userID)
    return channelUnread, nil
}
```

#### 3.2.4 数据库操作详解

**UpdateLastViewedAtPost** (`server/channels/store/sqlstore/channel_store.go:2686-2750`):

```go
func (s SqlChannelStore) UpdateLastViewedAtPost(
    unreadPost *model.Post, 
    userID string, 
    mentionCount, mentionCountRoot, urgentMentionCount int, 
    setUnreadCountRoot bool
) (*model.ChannelUnreadAt, error) {
    
    // 关键：未读起始时间 = 帖子创建时间 - 1
    // 这样该帖子及其之后的所有帖子都被视为"未读"
    unreadDate := unreadPost.CreateAt - 1
    
    // 计算该时间点之后的未读消息数
    unread, unreadRoot, err := s.CountPostsAfter(
        unreadPost.ChannelId, unreadDate, ""
    )
    
    // 如果不区分根帖子和回复，unreadRoot 设为 0
    if !setUnreadCountRoot {
        unreadRoot = 0
    }
    
    // 构建更新参数
    params := map[string]any{
        "mentions":        mentionCount,        // 从该帖子开始的提及数
        "mentionsroot":    mentionCountRoot,    // 从该帖子开始的根帖子提及数
        "urgentmentions":  urgentMentionCount,  // 紧急提及数
        "unreadcount":     unread,              // 未读消息总数
        "unreadcountroot": unreadRoot,          // 未读根帖子数
        "lastviewedat":    unreadDate,          // 关键：设置为帖子时间 - 1
        "userid":          userID,
        "channelid":       unreadPost.ChannelId,
        "updatedat":       model.GetMillis(),
    }
    
    // 更新 ChannelMembers
    // MsgCount = TotalMsgCount - unreadCount
    // MsgCountRoot = TotalMsgCountRoot - unreadCountRoot
    // LastViewedAt = unreadDate (帖子时间 - 1)
    // MentionCount = 传入的 mentionCount
    // ...
    
    // 然后查询并返回更新后的 ChannelUnreadAt
}
```

**核心设计**：

| 字段 | 值 | 含义 |
|------|-----|------|
| `LastViewedAt` | `post.CreateAt - 1` | 表示"最后查看于该帖子之前"，因此该帖子及其之后都是未读 |
| `MsgCount` | `TotalMsgCount - unreadCount` | 已读消息数 = 总消息数 - 未读数 |
| `MentionCount` | 计算出的 `mentionCount` | 该帖子及之后的提及数 |

**关键公式**：
```
未读消息数 = 频道总消息数 - 用户的已读消息数(MsgCount)
```

通过将 `MsgCount` 设置为 `TotalMsgCount - unreadCount`，可以精确控制从哪个帖子开始"未读"。

#### 3.2.5 线程级别的更新（仅回复帖子）

**UpdateMembership** (`server/channels/store/sqlstore/thread_store.go:714-758`):

```go
func (s *SqlThreadStore) UpdateMembership(membership *model.ThreadMembership) (*model.ThreadMembership, error) {
    // 更新 ThreadMemberships 表
    // - Following
    // - LastViewed     = post.CreateAt - 1 (关键！)
    // - LastUpdated
    // - UnreadMentions = 计算出的线程内提及数
}
```

**与频道级别的区别**：

| 维度 | 频道级别 | 线程级别 |
|------|----------|----------|
| 未读起始 | `post.CreateAt - 1` | `post.CreateAt - 1` (相同逻辑) |
| 计数方式 | `TotalMsgCount - unreadCount` | 基于 `LastViewed` 时间戳计算 |
| 触发条件 | 所有标记未读操作 | 仅当 `ThreadAutoFollow = true` 且标记的是**回复帖子** |

### 3.3 事件推送分析

#### 3.3.1 事件类型

**sendWebSocketPostUnreadEvent** (`server/channels/app/channel.go:3170-3180`):

```go
func (a *App) sendWebSocketPostUnreadEvent(
    rctx request.CTX, 
    channelUnread *model.ChannelUnreadAt, 
    postID string
) {
    message := model.NewWebSocketEvent(
        model.WebsocketEventPostUnread, 
        channelUnread.TeamId, 
        channelUnread.ChannelId, 
        channelUnread.UserId, 
        nil, ""
    )
    
    // 携带完整的未读状态
    message.Add("msg_count", channelUnread.MsgCount)
    message.Add("msg_count_root", channelUnread.MsgCountRoot)
    message.Add("mention_count", channelUnread.MentionCount)
    message.Add("mention_count_root", channelUnread.MentionCountRoot)
    message.Add("urgent_mention_count", channelUnread.UrgentMentionCount)
    message.Add("last_viewed_at", channelUnread.LastViewedAt)
    message.Add("post_id", postID)
    
    a.Publish(message)
}
```

#### 3.3.2 事件广播范围

| 事件类型 | 广播参数 | 目标 |
|----------|----------|------|
| `post_unread` | `TeamId`, `ChannelId`, `UserId` | 仅当前用户的所有连接 |
| `thread_updated` (可选) | `TeamId`, `""`, `UserId` | 仅当前用户（CRT 启用时） |

#### 3.3.3 事件携带数据对比

**post_unread 事件携带**：

```json
{
    "event": "post_unread",
    "data": {
        "msg_count": 150,           // 用户的已读消息数
        "msg_count_root": 100,       // 用户的已读根帖子数
        "mention_count": 3,          // 未读提及数
        "mention_count_root": 1,     // 未读根帖子提及数
        "urgent_mention_count": 0,   // 紧急提及数
        "last_viewed_at": 1704067199000,  // 最后查看时间
        "post_id": "abc123"          // 标记为未读的帖子ID
    }
}
```

**thread_updated 事件携带**：

```json
{
    "event": "thread_updated",
    "data": {
        "thread": {
            "id": "thread_abc",
            "unread_replies": 5,
            "unread_mentions": 2,
            "last_viewed_at": 1704067199000,
            "following": true,
            // ... 完整线程信息
        }
    }
}
```

### 3.4 跨端收敛分析

#### 3.4.1 事件驱动的状态更新

**客户端收到事件后的行为**：

| 事件 | 客户端行为 |
|------|------------|
| `post_unread` | - 用事件携带的数据更新本地 `ChannelUnread`<br>- 插入"新消息"分隔线<br>- 更新频道列表未读指示器 |
| `thread_updated` | - 更新线程的未读计数<br>- 如果正在查看该线程，刷新 UI |

#### 3.4.2 收敛机制

**"新消息"分隔线的实现**：

`post_unread` 事件携带 `post_id`，客户端可以：
1. 在该帖子之前插入"新消息"视觉分隔线
2. 所有在该帖子之后的消息显示为"未读"样式

**与标已读的收敛对比**：

| 维度 | 标已读 (链路 A) | 标未读 (链路 B) |
|------|------------------|------------------|
| 时间戳方向 | `LastViewedAt` 向前推进（最新消息时间） | `LastViewedAt` 向后回退（指定帖子时间 - 1） |
| 计数更新 | 清零 `MentionCount` | 精确设置 `MentionCount` |
| 事件数据 | 仅 `channel_times` (时间戳映射) | 完整的 `ChannelUnreadAt` 所有字段 |
| 线程级别 | 批量更新（按频道） | 仅更新特定线程（标记的是回复时） |

---

## 4. 两条链路对比分析

### 4.1 入口对比

| 维度 | 链路 A：标已读 | 链路 B：标未读 |
|------|----------------|----------------|
| **API 端点** | `POST /channels/members/me/view` | `POST /users/{user_id}/posts/{post_id}/set_unread` |
| **触发方式** | 隐式：用户切换/进入频道 | 显式：用户右键菜单选择"标记为未读" |
| **权限检查** | 仅检查是否是频道成员 | 检查是自己的状态 OR 有 `manage_system` 权限 |
| **处理粒度** | 频道级别（可批量多个频道） | 帖子级别（单个帖子为锚点） |
| **额外参数** | `prev_channel_id`（同时标记之前的频道） | 无（URL 路径参数） |

### 4.2 状态持久化对比

#### 4.2.1 时间戳策略

| 链路 | LastViewedAt 设置 | 逻辑 |
|------|--------------------|------|
| **标已读** | `greatest(current, LastPostAt)` | 对齐到频道最新消息时间，表示"已看到最新" |
| **标未读** | `post.CreateAt - 1` | 回退到指定帖子之前，表示"该帖子及其之后都是未读" |

#### 4.2.2 计数策略

| 链路 | MsgCount 策略 | MentionCount 策略 |
|------|---------------|-------------------|
| **标已读** | `greatest(current, TotalMsgCount)` - 对齐到总消息数 | 直接设为 `0` |
| **标未读** | `TotalMsgCount - unreadCount` - 精确计算 | 设为 `countMentionsFromPost()` 的返回值 |

#### 4.2.3 线程级别处理

| 链路 | 线程级别触发条件 | 操作 |
|------|------------------|------|
| **标已读** | `ThreadAutoFollow = true` AND (`!collapsedThreadsSupported` OR `!isCRTEnabled`) | 批量更新频道内所有线程：`LastViewed = now`, `UnreadMentions = 0` |
| **标未读** | `ThreadAutoFollow = true` AND 标记的是**回复帖子** (`post.RootId != ""`) | 更新特定线程：`LastViewed = post.CreateAt - 1`, `UnreadMentions = countThreadMentions()` |

### 4.3 事件推送对比

#### 4.3.1 事件类型与触发条件

| 事件类型 | 链路 A (标已读) | 链路 B (标未读) | 触发条件 |
|----------|------------------|------------------|----------|
| `multiple_channels_viewed` | ✅ 可能发送 | ❌ 不发送 | `EnableChannelViewedMessages = true` |
| `thread_read_changed` | ⚠️ 条件发送 | ❌ 不发送 | `updateThreads = true` AND `isCRTEnabled = true` |
| `post_unread` | ❌ 不发送 | ✅ 始终发送 | 所有标记未读操作 |
| `thread_updated` | ❌ 不发送 | ⚠️ 条件发送 | `ThreadAutoFollow = true` AND 回复帖子 AND `isCRTEnabled` |

#### 4.3.2 事件数据对比

| 维度 | 标已读事件 | 标未读事件 |
|------|------------|------------|
| **数据量** | 小：仅 `channel_times` 映射 | 大：完整 `ChannelUnreadAt` 所有字段 |
| **包含字段** | `{ channelID: lastViewedAt }` | `msg_count`, `msg_count_root`, `mention_count`, `mention_count_root`, `urgent_mention_count`, `last_viewed_at`, `post_id` |
| **用途** | 增量同步时间戳 | 完整状态覆盖 + 视觉分隔线定位 |
| **线程级别** | 仅时间戳 | 完整 `ThreadResponse` 对象 |

#### 4.3.3 广播范围

| 事件 | 广播策略 | 目标客户端 |
|------|----------|------------|
| `multiple_channels_viewed` | `UserId = 当前用户`, `TeamId = ""`, `ChannelId = ""` | 当前用户的**所有设备** |
| `thread_read_changed` | `UserId = 当前用户`, `ChannelId = 指定频道` | 当前用户的**所有设备**（在该频道的连接） |
| `post_unread` | `UserId = 当前用户`, `TeamId = 帖子团队`, `ChannelId = 帖子频道` | 当前用户的**所有设备** |
| `thread_updated` (标未读时) | `UserId = 当前用户`, `TeamId = 线程团队` | 当前用户的**所有设备** |

**关键发现**：
- 两条链路的事件都**只发送给当前用户**，不广播给其他用户
- 这确保了未读状态是**用户私有的**，不会影响其他人
- 但当前用户的**所有设备**都会收到，实现跨端同步

### 4.4 跨端收敛差异

#### 4.4.1 收敛机制对比

| 维度 | 标已读 (链路 A) | 标未读 (链路 B) |
|------|------------------|------------------|
| **收敛模式** | 时间戳驱动 | 完整状态驱动 |
| **客户端依赖** | 依赖本地计算未读数 | 直接使用服务端返回的计数 |
| **视觉分隔线** | 无（不需要） | 有（通过 `post_id` 定位） |
| **竞争条件风险** | 低（时间戳单调递增） | 中（可能有并发的新消息） |

#### 4.4.2 竞争条件分析

**标已读的竞争条件**：

```
时间线：
t1: 客户端 A 进入频道 X → 标已读请求发出
t2: 新消息到达频道 X → MsgCount++, LastPostAt 更新
t3: 标已读执行：
    - LastViewedAt = greatest(t1 时的 LastPostAt, c.LastPostAt)
    - 实际上会使用 t2 后的新 LastPostAt
    - MsgCount = greatest(current, TotalMsgCount) → 对齐到新总数
    
→ 结果：即使有并发新消息，也会被正确标记为"已读"（因为用户正在查看）
```

**标未读的竞争条件**：

```
时间线：
t1: 用户标记帖子 P 为未读（CreateAt = 1000）
    → 计算 unreadDate = 999
    → 计算 CountPostsAfter(999) = 5 条消息（包括 P）
    → 计算 countMentionsFromPost(P) = 2 个提及
    
t2: 新消息 Q 到达（CreateAt = 1001，有 1 个提及）
    → 但这个时间点在计算之后
    
t3: 执行 UpdateLastViewedAtPost
    → LastViewedAt = 999
    → MsgCount = TotalMsgCount - 5
    → MentionCount = 2
    
→ 问题：消息 Q 也在 999 之后，但计算时没包含它
→ 结果：Q 的计数不会被反映在这次操作中
→ 但 Q 自己的 posted 事件会单独发送，客户端会收到
```

**设计取舍**：
- 标未读使用的是**快照式**计算（计算时的状态）
- 但新消息有自己的 `posted` 事件，会独立通知
- 最终状态会通过多个事件的组合收敛到正确值

---

## 5. 关键分支条件与时序图

### 5.1 链路 A：标已读的分支条件

```
MarkChannelsAsViewed 入口
    │
    ├─── 是否有频道需要标记？
    │   ├─── 否 (len(channelsToView) == 0)
    │   │       └─── 直接返回，不做任何操作
    │   │
    │   └─── 是
    │           │
    │           ├─── updateThreads?
    │           │   (ThreadAutoFollow && (!collapsedThreadsSupported || !isCRTEnabled))
    │           │   │
    │           │   ├─── 是
    │           │   │       ├─── MarkAllAsReadByChannels (线程级别)
    │           │   │       │
    │           │   │       └─── isCRTEnabled?
    │           │   │           └─── 是
    │           │   │               └─── 发送 thread_read_changed 事件
    │           │   │
    │           │   └─── 否
    │           │           └─── 跳过线程级别处理
    │           │
    │           ├─── UpdateLastViewedAt (频道级别)
    │           │
    │           ├─── EnableChannelViewedMessages?
    │           │   └─── 是
    │           │       └─── 发送 multiple_channels_viewed 事件
    │           │
    │           └─── 清除推送通知
    │
    └─── 返回 channel_times
```

### 5.2 链路 B：标未读的分支条件

```
MarkChannelAsUnreadFromPost 入口
    │
    ├─── CRT 启用？
    │   (collapsedThreadsSupported && IsCRTEnabled)
    │   │
    │   ├─── 否 ─────────────────────────────────────┐
    │   │                                               │
    │   │       markChannelAsUnreadFromPostCRTUnsupported
    │   │                                               │
    │   │       ├─── 获取帖子、用户
    │   │       ├─── 计算 threadId = post.RootId || post.Id
    │   │       ├─── countMentionsFromPost
    │   │       │
    │   │       ├─── 是根帖子？(post.RootId == "")
    │   │       │   ├─── 是
    │   │       │   │       ├─── UpdateLastViewedAtPost(setUnreadCountRoot=true)
    │   │       │   │       ├─── 发送 post_unread 事件
    │   │       │   │       └─── 返回
    │   │       │   │
    │   │       │   └─── 否 (是回复帖子)
    │   │       │           │
    │   │       │           ├─── ThreadAutoFollow?
    │   │       │           │   └─── 是
    │   │       │           │       ├─── 确保用户关注线程 (MaintainMembership)
    │   │       │           │       ├─── 设置 LastViewed = post.CreateAt - 1
    │   │       │           │       ├─── countThreadMentions
    │   │       │           │       ├─── UpdateMembership
    │   │       │           │       │
    │   │       │           │       └─── isCRTEnabled?
    │   │       │           │           └─── 是
    │   │       │           │               └─── 发送 thread_updated 事件
    │   │       │           │
    │   │       │           ├─── UpdateLastViewedAtPost(setUnreadCountRoot=false)
    │   │       │           ├─── 发送 post_unread 事件
    │   │       │           └─── 返回
    │   │       │
    │   │       └─── (继续)
    │   │
    │   └─── 是 (CRT 启用) ─────────────────────────┘
    │                                                   │
    │           MarkChannelAsUnreadFromPost (简化路径)
    │                                                   │
    │           ├─── 获取帖子、用户
    │           ├─── countMentionsFromPost
    │           ├─── UpdateLastViewedAtPost(setUnreadCountRoot=true)
    │           ├─── 发送 post_unread 事件
    │           └─── 返回
    │
    └─── 统一返回 ChannelUnreadAt
```

### 5.3 时序图

#### 5.3.1 标已读时序

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ 客户端 A │         │  API 层  │         │  App 层  │         │  存储层  │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │ POST /channels/members/me/view           │                     │
     │ { channel_id: "ch_1", prev_channel_id: "ch_2" }              │
     │────────────────────>│                     │                     │
     │                     │                     │                     │
     │                     │ ViewChannel()       │                     │
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │                     │ GetChannelsWithUnreadsAndWithMentions
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ channelsToView = [ch_1, ch_2]
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │                     │ [分支] updateThreads?
     │                     │                     │──┐                  │
     │                     │                     │  │ 是               │
     │                     │                     │  │                  │
     │                     │                     │  │ MarkAllAsReadByChannels
     │                     │                     │  │─────────────────>│
     │                     │                     │  │                  │
     │                     │                     │  │ Update ThreadMemberships
     │                     │                     │  │ Set LastViewed=now, UnreadMentions=0
     │                     │                     │  │<─────────────────│
     │                     │                     │<─┘                  │
     │                     │                     │                     │
     │                     │                     │ UpdateLastViewedAt
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ Update ChannelMembers
     │                     │                     │ Set LastViewedAt=LastPostAt
     │                     │                     │ MentionCount=0
     │                     │                     │ MsgCount=TotalMsgCount
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │                     │ [条件] EnableChannelViewedMessages?
     │                     │                     │──┐                  │
     │                     │                     │  │ 是               │
     │                     │                     │  │                  │
     │                     │                     │  │ Publish multiple_channels_viewed
     │                     │<───────────────────────────────────────────│ (所有设备)
     │                     │                     │  │                  │
     │                     │                     │<─┘                  │
     │                     │                     │                     │
     │                     │                     │ [条件] updateThreads && isCRTEnabled?
     │                     │                     │──┐                  │
     │                     │                     │  │ 是               │
     │                     │                     │  │                  │
     │                     │                     │  │ Publish thread_read_changed
     │                     │<───────────────────────────────────────────│ (所有设备)
     │                     │                     │  │                  │
     │                     │                     │<─┘                  │
     │                     │                     │                     │
     │                     │ 200 OK { "ch_1": ts, "ch_2": ts }       │
     │<────────────────────│                     │                     │
     │                     │                     │                     │
```

#### 5.3.2 标未读时序（非 CRT，回复帖子，ThreadAutoFollow 启用）

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ 客户端 A │         │  API 层  │         │  App 层  │         │  存储层  │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │ POST /users/me/posts/post_123/set_unread│                     │
     │────────────────────>│                     │                     │
     │                     │                     │                     │
     │                     │ MarkChannelAsUnreadFromPost               │
     │                     │ (collapsedThreadsSupported=false)          │
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │                     │ [分支] CRT 启用？
     │                     │                     │──┐                  │
     │                     │                     │  │ 否               │
     │                     │                     │  │                  │
     │                     │                     │  │ markChannelAsUnreadFromPostCRTUnsupported
     │                     │                     │  │                  │
     │                     │                     │  │ GetSinglePost(post_123)
     │                     │                     │  │─────────────────>│
     │                     │                     │  │                  │
     │                     │                     │  │ Post { Id: "post_123", RootId: "root_456", ... }
     │                     │                     │  │<─────────────────│
     │                     │                     │  │                  │
     │                     │                     │  │ GetUser(user_789)
     │                     │                     │  │─────────────────>│
     │                     │                     │  │                  │
     │                     │                     │  │ User { ... }
     │                     │                     │  │<─────────────────│
     │                     │                     │  │                  │
     │                     │                     │  │ threadId = "root_456" (post.RootId)
     │                     │                     │  │                  │
     │                     │                     │  │ countMentionsFromPost
     │                     │                     │  │ (计算 post_123 及之后的提及)
     │                     │                     │  │                  │
     │                     │                     │  │ [分支] 是根帖子？
     │                     │                     │  │──┐               │
     │                     │                     │  │  │ 否            │
     │                     │                     │  │  │ (是回复)      │
     │                     │                     │  │  │               │
     │                     │                     │  │  │ GetSinglePost(root_456)
     │                     │                     │  │  │──────────────>│
     │                     │                     │  │  │               │
     │                     │                     │  │  │ RootPost { ... }
     │                     │                     │  │  │<──────────────│
     │                     │                     │  │  │               │
     │                     │                     │  │  │ GetChannel(post.ChannelId)
     │                     │                     │  │  │──────────────>│
     │                     │                     │  │  │               │
     │                     │                     │  │  │ Channel { ... }
     │                     │                     │  │  │<──────────────│
     │                     │                     │  │  │               │
     │                     │                     │  │  │ [条件] ThreadAutoFollow?
     │                     │                     │  │  │──┐            │
     │                     │                     │  │  │  │ 是         │
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ GetMembershipForUser(user, root_456)
     │                     │                     │  │  │  │────────────>│
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ 假设：还没关注 (ErrNotFound)
     │                     │                     │  │  │  │<────────────│
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ MaintainMembership (创建关注)
     │                     │                     │  │  │  │ Following=true
     │                     │                     │  │  │  │────────────>│
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ ThreadMembership created
     │                     │                     │  │  │  │<────────────│
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ 更新成员关系：
     │                     │                     │  │  │  │ - LastViewed = post.CreateAt - 1
     │                     │                     │  │  │  │ - UnreadMentions = countThreadMentions()
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ UpdateMembership
     │                     │                     │  │  │  │────────────>│
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ Updated
     │                     │                     │  │  │  │<────────────│
     │                     │                     │  │  │  │            │
     │                     │                     │  │  │  │ [条件] isCRTEnabled?
     │                     │                     │  │  │  │──┐         │
     │                     │                     │  │  │  │  │ 假设: 否 │
     │                     │                     │  │  │  │  │ 跳过事件 │
     │                     │                     │  │  │  │<─┘         │
     │                     │                     │  │  │<─┘            │
     │                     │                     │  │  │               │
     │                     │                     │  │  │ UpdateLastViewedAtPost
     │                     │                     │  │  │ (setUnreadCountRoot=false)
     │                     │                     │  │  │──────────────>│
     │                     │                     │  │  │               │
     │                     │                     │  │  │ 更新 ChannelMembers：
     │                     │                     │  │  │ - LastViewedAt = post.CreateAt - 1
     │                     │                     │  │  │ - MsgCount = TotalMsgCount - unreadCount
     │                     │                     │  │  │ - MentionCount = 计算的提及数
     │                     │                     │  │  │               │
     │                     │                     │  │  │ ChannelUnreadAt { ... }
     │                     │                     │  │  │<──────────────│
     │                     │                     │  │  │               │
     │                     │                     │  │  │ sendWebSocketPostUnreadEvent
     │                     │<───────────────────────────────────────────│ (所有设备)
     │                     │                     │  │  │               │
     │                     │                     │  │<─┘               │
     │                     │                     │<─┘                  │
     │                     │                     │                     │
     │                     │ 200 OK { ChannelUnreadAt }                │
     │<────────────────────│                     │                     │
     │                     │                     │                     │
```

---

## 6. 代码位置索引

### 6.1 链路 A：标已读

| 功能 | 文件路径 | 行号 |
|------|----------|------|
| API 入口 | `server/channels/api4/channel.go` | （viewChannel 函数） |
| ViewChannel | `server/channels/app/channel.go` | 3390-3410 |
| MarkChannelsAsViewed | `server/channels/app/channel.go` | 3331-3388 |
| UpdateLastViewedAt（存储） | `server/channels/store/sqlstore/channel_store.go` | 2548-2604 |
| MarkAllAsReadByChannels（存储） | `server/channels/store/sqlstore/thread_store.go` | 621-642 |
| MultipleChannelsViewed 事件 | `server/public/model/websocket_message.go` | （常量定义） |
| ThreadReadChanged 事件 | `server/public/model/websocket_message.go` | 77 |

### 6.2 链路 B：标未读

| 功能 | 文件路径 | 行号 |
|------|----------|------|
| API 入口 | `server/channels/api4/post.go` | 1244-1269 |
| MarkChannelAsUnreadFromPost（CRT 启用） | `server/channels/app/channel.go` | 3031-3060 |
| markChannelAsUnreadFromPostCRTUnsupported | `server/channels/app/channel.go` | 3062-3168 |
| sendWebSocketPostUnreadEvent | `server/channels/app/channel.go` | 3170-3180 |
| UpdateLastViewedAtPost（存储） | `server/channels/store/sqlstore/channel_store.go` | 2686-2750 |
| UpdateMembership（存储） | `server/channels/store/sqlstore/thread_store.go` | 714-758 |
| PostUnread 事件 | `server/public/model/websocket_message.go` | （常量定义） |
| ThreadUpdated 事件 | `server/public/model/websocket_message.go` | （常量定义） |

---

## 7. 总结与关键发现

### 7.1 核心设计原则

1. **用户私有未读状态**
   - 所有未读状态都是用户私有的（`ChannelMembers.UserId`, `ThreadMemberships.UserId`）
   - WebSocket 事件只发送给当前用户，不影响其他用户

2. **双轨未读跟踪**
   - 频道级别：`ChannelMembers` 表
   - 线程级别：`ThreadMemberships` 表
   - 两条链路在不同条件下更新一个或两个表

3. **时间戳优先于计数**
   - `LastViewedAt` / `LastViewed` 是真相源
   - 计数值可以从时间戳派生，但直接存储计数值是为了性能优化

4. **事件驱动的跨端同步**
   - 每个操作后发送特定的 WebSocket 事件
   - 事件携带必要的数据（时间戳或完整状态）
   - 客户端接收事件后更新本地状态

### 7.2 两条链路的本质差异

| 维度 | 标已读 | 标未读 |
|------|--------|--------|
| **操作语义** | "我已看到最新" | "从这里开始我没看" |
| **时间戳方向** | 向前推进（单调递增） | 向后回退（可以任意位置） |
| **计数策略** | 清零 / 对齐 | 精确计算 / 设置 |
| **线程级别触发** | 批量更新频道内所有线程 | 仅更新特定线程（回复帖子时） |
| **事件数据** | 最小化（仅时间戳） | 完整化（所有未读状态） |

### 7.3 CRT 功能的影响

CRT (Collapsed Reply Threads) 是关键的分支条件：

1. **标已读**
   - CRT 未启用时才会批量更新线程
   - CRT 启用时线程未读由客户端自己管理

2. **标未读**
   - CRT 启用时使用简化路径（只更新频道）
   - CRT 未启用时使用完整路径（频道 + 线程）
   - 只有 CRT 启用时才发送 `thread_updated` 事件

### 7.4 跨端收敛机制

**收敛策略**：
1. **事件通知**：操作后立即发送 WebSocket 事件
2. **状态对齐**：事件携带足够的数据让客户端更新本地状态
3. **最终一致性**：客户端可以通过重新拉取频道/线程列表来"对齐"

**竞争条件处理**：
- 标已读：使用 `greatest()` 函数，天然处理并发
- 标未读：快照式计算，但新消息有独立的 `posted` 事件通知
- 两种情况最终都会收敛到正确状态

---

*分析日期：2026-05-02*
*基于 Mattermost 代码库版本：v8.x*
