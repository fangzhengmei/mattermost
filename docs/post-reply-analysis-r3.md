# Mattermost 未读同步闭环深度分析（修订版）

## 1. 概述

本文档在之前分析的基础上，补齐两条线程级别的 API 链路，形成完整的**四条未读同步链路**分析：

| 链路编号 | 链路名称 | 操作语义 | 粒度 |
|----------|----------|----------|------|
| **链路 A** | 频道级标已读 | 查看频道后自动标记所有消息为已读 | 频道级 |
| **链路 B** | 频道级标未读 | 手动将某个帖子标记为未读（影响整个频道） | 频道级 |
| **链路 C** | 线程级标已读 | 查看线程后标记该线程为已读 | 线程级 |
| **链路 D** | 按帖子标线程未读 | 手动将线程中某个帖子标记为未读 | 线程级 |

本文档重点对比：
- **入口**：API 端点、调用方式
- **状态持久化**：数据库操作、字段更新
- **事件推送**：WebSocket 事件类型、载荷字段
- **跨端收敛**：与频道级路径的关系、webapp 处理逻辑

---

## 2. 四条链路总览

### 2.1 入口对比

| 链路 | HTTP 方法 | API 端点 | 核心函数 |
|------|-----------|----------|----------|
| **A. 频道级标已读** | POST | `/api/v4/channels/members/me/view` | `ViewChannel()` → `MarkChannelsAsViewed()` |
| **B. 频道级标未读** | POST | `/api/v4/users/{user_id}/posts/{post_id}/set_unread` | `MarkChannelAsUnreadFromPost()` |
| **C. 线程级标已读** | PUT | `/api/v4/users/{user_id}/teams/{team_id}/threads/{thread_id}/read/{timestamp}` | `UpdateThreadReadForUser()` |
| **D. 按帖子标线程未读** | POST | `/api/v4/users/{user_id}/teams/{team_id}/threads/{thread_id}/set_unread/{post_id}` | `UpdateThreadReadForUserByPost()` → `UpdateThreadReadForUser()` |

### 2.2 关键发现：链路 C 和 D 的共通性

**核心洞察**：链路 C 和链路 D 使用**完全相同的底层函数** `UpdateThreadReadForUser()`，区别仅在于**传入的时间戳方向**：

| 链路 | 时间戳参数 | 语义 |
|------|------------|------|
| **C. 线程级标已读** | `replyPost.CreateAt + 1` 或当前时间 | 时间戳**向前推进**，表示"已看到最新" |
| **D. 按帖子标线程未读** | `post.CreateAt - 1` | 时间戳**向后回退**，表示"该帖子之后未读" |

两条链路发送**完全相同的 WebSocket 事件** `WebsocketEventThreadReadChanged`，客户端通过比较 `timestamp` 和 `previous_unread_*` 与当前状态来判断是"标已读"还是"标未读"。

---

## 3. 链路 C：线程级标已读

### 3.1 入口分析

#### 3.1.1 API 端点

**定义** (`server/channels/api4/user.go:3739`):

```go
func updateThreadReadForUser(c *Context, w http.ResponseWriter, r *http.Request) {
    // PUT /users/{user_id}/teams/{team_id}/threads/{thread_id}/read/{timestamp}
    
    thread, err := c.App.UpdateThreadReadForUser(
        c.AppContext, 
        c.AppContext.Session().Id, 
        c.Params.UserId, 
        c.Params.TeamId, 
        c.Params.ThreadId, 
        c.Params.Timestamp  // 关键：时间戳参数
    )
    // ...
}
```

**URL 参数**：

| 参数 | 类型 | 作用 |
|------|------|------|
| `user_id` | string | 操作用户 ID |
| `team_id` | string | 团队 ID |
| `thread_id` | string | 线程 ID（即根帖子 ID） |
| `timestamp` | int64 | **关键时间戳**：表示"已看到这个时间点" |

#### 3.1.2 客户端调用场景

**典型场景**：
1. 用户在 CRT（折叠回复线程）视图中查看某个线程
2. 用户滚动到线程底部
3. 客户端调用 `UpdateThreadReadForUser` 传入 `GetMillis()` 或 `lastReply.CreateAt + 1`

**客户端代码** (`webapp/channels/src/packages/mattermost-redux/src/actions/threads.ts:318`):

```typescript
export function updateThreadRead(
    userId: string, 
    teamId: string, 
    threadId: string, 
    timestamp: number  // 传入时间戳
): ActionFuncAsync {
    return async (dispatch, getState) => {
        await Client4.updateThreadReadForUser(userId, teamId, threadId, timestamp);
        return {};
    };
}
```

### 3.2 状态持久化分析

#### 3.2.1 核心实现

**UpdateThreadReadForUser** (`server/channels/app/user.go:3100-3157`):

```go
func (a *App) UpdateThreadReadForUser(
    rctx request.CTX, 
    currentSessionId, userID, teamID, threadID string, 
    timestamp int64  // 关键参数
) (*model.ThreadResponse, *model.AppError) {
    
    // 1. 获取用户
    user, err := a.GetUser(userID)
    
    // 2. 确保用户有该线程的成员关系
    //    如果没有，说明用户没有关注该线程，不能标记已读/未读
    membership, err := a.GetThreadMembershipForUser(userID, threadID)
    
    // 3. 保存之前的未读状态（用于事件推送的增量字段）
    previousUnreadMentions := membership.UnreadMentions
    previousUnreadReplies, nErr := a.Srv().Store().Thread().GetThreadUnreadReplyCount(membership)
    
    // 4. 获取根帖子
    post, err := a.GetSinglePost(rctx, threadID, false)
    
    // 5. 重新计算未读提及数
    //    从给定 timestamp 开始计算该线程中的提及
    membership.UnreadMentions, err = a.countThreadMentions(
        rctx, user, post, teamID, timestamp
    )
    
    // 6. 更新成员关系
    _, nErr = a.Srv().Store().Thread().UpdateMembership(membership)
    
    // 7. 设置 LastViewed 并标记为已读
    membership.LastViewed = timestamp  // 关键！设置最后查看时间
    
    nErr = a.Srv().Store().Thread().MarkAsRead(userID, threadID, timestamp)
    
    // 8. 获取更新后的线程数据
    thread, err := a.GetThreadForUser(rctx, membership, false)
    
    // 9. 如果未读回复为 0 且用户启用 CRT，清除推送通知
    if thread.UnreadReplies == 0 && a.IsCRTEnabledForUser(rctx, userID) {
        a.clearPushNotification(currentSessionId, userID, post.ChannelId, threadID)
    }
    
    // 10. 发送 WebSocket 事件
    message := model.NewWebSocketEvent(
        model.WebsocketEventThreadReadChanged, 
        teamID, "", userID, nil, ""
    )
    message.Add("thread_id", threadID)
    message.Add("timestamp", timestamp)
    message.Add("unread_mentions", membership.UnreadMentions)
    message.Add("unread_replies", thread.UnreadReplies)
    message.Add("previous_unread_mentions", previousUnreadMentions)
    message.Add("previous_unread_replies", previousUnreadReplies)
    message.Add("channel_id", post.ChannelId)
    a.Publish(message)
    
    return thread, nil
}
```

#### 3.2.2 数据库操作

**MarkAsRead** (`server/channels/store/sqlstore/thread_store.go:684-698`):

```go
func (s *SqlThreadStore) MarkAsRead(userId, threadId string, timestamp int64) error {
    // 更新 ThreadMemberships 表
    // - LastViewed = timestamp
    // - LastUpdated = 当前时间
    // 条件：UserId = userId AND PostId = threadId
    
    query := s.getQueryBuilder().
        Update("ThreadMemberships").
        Where(sq.Eq{"UserId": userId}).
        Where(sq.Eq{"PostId": threadId}).
        Set("LastViewed", timestamp).
        Set("LastUpdated", model.GetMillis())
    
    _, err := s.GetMaster().ExecBuilder(query)
    // ...
}
```

**关键字段更新**：

| 字段 | 新值 | 语义 |
|------|------|------|
| `LastViewed` | `timestamp` (传入的时间戳) | 用户最后查看该线程的时间 |
| `LastUpdated` | `model.GetMillis()` | 成员关系更新时间 |
| `UnreadMentions` | `countThreadMentions(..., timestamp)` | 从 timestamp 开始的未读提及数 |

#### 3.2.3 未读计数计算

**countThreadMentions** 函数的作用：
- 从给定的 `timestamp` 开始
- 计算该线程中所有 `CreateAt > timestamp` 的帖子
- 统计其中有多少个提及了当前用户

**标已读时**：
- 传入一个**较大的时间戳**（如 `lastReply.CreateAt + 1` 或当前时间）
- `countThreadMentions` 返回 `0`（没有帖子在这个时间戳之后）
- `UnreadMentions = 0`

---

## 4. 链路 D：按帖子标线程未读

### 4.1 入口分析

#### 4.1.1 API 端点

**定义** (`server/channels/api4/user.go:3752-3798`):

```go
func setUnreadThreadByPostId(c *Context, w http.ResponseWriter, r *http.Request) {
    // POST /users/{user_id}/teams/{team_id}/threads/{thread_id}/set_unread/{post_id}
    
    c.RequireUserId().RequireThreadId().RequirePostId().RequireTeamId()
    
    // 1. 确保线程被关注
    //    https://mattermost.atlassian.net/browse/MM-36430
    err := c.App.UpdateThreadFollowForUser(
        c.Params.UserId, 
        c.Params.TeamId, 
        c.Params.ThreadId, 
        true  // 强制关注
    )
    
    // 2. 调用按帖子标未读
    thread, err := c.App.UpdateThreadReadForUserByPost(
        c.AppContext, 
        c.AppContext.Session().Id, 
        c.Params.UserId, 
        c.Params.TeamId, 
        c.Params.ThreadId, 
        c.Params.PostId  // 关键：帖子 ID
    )
    // ...
}
```

**URL 参数**：

| 参数 | 类型 | 作用 |
|------|------|------|
| `user_id` | string | 操作用户 ID |
| `team_id` | string | 团队 ID |
| `thread_id` | string | 线程 ID |
| `post_id` | string | **锚点帖子 ID**：该帖子及其之后为未读 |

#### 4.1.2 前置条件：强制关注

**关键代码** (`api4/user.go:3781`):

```go
// We want to make sure the thread is followed when marking as unread
// https://mattermost.atlassian.net/browse/MM-36430
err := c.App.UpdateThreadFollowForUser(c.Params.UserId, c.Params.TeamId, c.Params.ThreadId, true)
```

**设计意图**：
- 如果用户手动将某个帖子标记为未读，说明用户关心这个线程
- 系统自动将该线程加入关注列表
- 确保后续的更新通知能正常送达

### 4.2 状态持久化分析

#### 4.2.1 核心实现

**UpdateThreadReadForUserByPost** (`server/channels/app/user.go:3087-3098`):

```go
func (a *App) UpdateThreadReadForUserByPost(
    rctx request.CTX, 
    currentSessionId, userID, teamID, threadID, postID string
) (*model.ThreadResponse, *model.AppError) {
    
    // 1. 获取锚点帖子
    post, err := a.GetSinglePost(rctx, postID, false)
    
    // 2. 验证帖子属于该线程
    //    帖子要么是根帖子（postID == threadID）
    //    要么是回复（post.RootId == threadID）
    if post.RootId != threadID && postID != threadID {
        return nil, model.NewAppError(
            "UpdateThreadReadForUser", 
            "app.user.update_thread_read_for_user_by_post.app_error", 
            nil, "", http.StatusBadRequest
        )
    }
    
    // 3. 关键转换：post.CreateAt - 1
    //    表示"最后查看于该帖子之前"
    return a.UpdateThreadReadForUser(
        rctx, currentSessionId, userID, teamID, threadID, 
        post.CreateAt - 1  // 注意：时间戳向前回退！
    )
}
```

**核心洞察**：

这个函数本身不做实际的持久化操作，它只是：
1. 验证帖子-线程关系
2. **将 `postID` 转换为 `post.CreateAt - 1`**
3. 调用相同的 `UpdateThreadReadForUser` 函数

#### 4.2.2 时间戳转换逻辑

| 场景 | 锚点帖子 | 转换后的时间戳 | 语义 |
|------|----------|----------------|------|
| 标未读 | `post` (CreateAt = 1000) | `1000 - 1 = 999` | 最后查看于 999，因此 1000 及其之后都是未读 |
| 标已读 | 无（直接传时间戳） | `GetMillis()` 或 `lastReply.CreateAt + 1` | 已看到最新 |

#### 4.2.3 未读计数计算（标未读时）

**标未读时**：
- 传入一个**较小的时间戳**（`post.CreateAt - 1`）
- `countThreadMentions` 计算所有 `CreateAt > timestamp` 的帖子中的提及数
- `UnreadMentions` = 该帖子及其之后的提及数

**与频道级标未读的区别**：

| 维度 | 链路 B（频道级标未读） | 链路 D（线程级标未读） |
|------|------------------------|------------------------|
| 影响范围 | 整个频道的 `ChannelMembers` | 单个线程的 `ThreadMembership` |
| 计数字段 | `MsgCount`, `MentionCount` (频道级) | `LastViewed`, `UnreadMentions` (线程级) |
| 频道级影响 | 会更新频道 `LastViewedAt` | **不影响**频道级未读状态 |
| 适用视图 | 传统视图 + CRT 视图 | **仅 CRT 视图** |

---

## 5. 事件推送对比分析

### 5.1 四条链路的事件类型

| 链路 | 事件类型 | 广播范围 | 触发条件 |
|------|----------|----------|----------|
| **A. 频道级标已读** | `multiple_channels_viewed` (可选) | 当前用户所有设备 | `EnableChannelViewedMessages = true` |
| | `thread_read_changed` (可选) | 当前用户 + 指定频道 | `updateThreads && isCRTEnabled` |
| **B. 频道级标未读** | `post_unread` | 当前用户所有设备 | 始终发送 |
| | `thread_updated` (可选) | 当前用户 | `ThreadAutoFollow` + 回复帖子 + `isCRTEnabled` |
| **C. 线程级标已读** | `thread_read_changed` | 当前用户所有设备 | 始终发送 |
| **D. 线程级标未读** | `thread_read_changed` | 当前用户所有设备 | 始终发送 |

### 5.2 thread_read_changed 事件详细分析

**事件创建** (`server/channels/app/user.go:3147-3155`):

```go
message := model.NewWebSocketEvent(
    model.WebsocketEventThreadReadChanged, 
    teamID,     // teamId
    "",         // channelId = "" (空)
    userID,     // userId = 当前用户
    nil, ""
)
message.Add("thread_id", threadID)
message.Add("timestamp", timestamp)
message.Add("unread_mentions", membership.UnreadMentions)
message.Add("unread_replies", thread.UnreadReplies)
message.Add("previous_unread_mentions", previousUnreadMentions)
message.Add("previous_unread_replies", previousUnreadReplies)
message.Add("channel_id", post.ChannelId)
a.Publish(message)
```

#### 5.2.1 事件载荷字段

| 字段 | 类型 | 来源 | 作用 |
|------|------|------|------|
| `thread_id` | string | 入参 `threadID` | 标识哪个线程 |
| `timestamp` | int64 | 入参或 `post.CreateAt - 1` | 新的 `LastViewed` 值 |
| `unread_mentions` | int64 | `membership.UnreadMentions` | 新的未读提及数 |
| `unread_replies` | int64 | `thread.UnreadReplies` | 新的未读回复数 |
| `previous_unread_mentions` | int64 | 操作前的 `membership.UnreadMentions` | **增量计算**：之前的未读提及数 |
| `previous_unread_replies` | int64 | 操作前的计数 | **增量计算**：之前的未读回复数 |
| `channel_id` | string | `post.ChannelId` | 线程所属频道 |

#### 5.2.2 广播范围

```go
model.NewWebSocketEvent(
    model.WebsocketEventThreadReadChanged, 
    teamID,     // 团队 ID
    "",         // channelId = "" (不限制频道)
    userID,     // userId = 当前用户（关键！）
    nil, ""
)
```

**广播策略**：
- `teamId` = 线程所属团队
- `channelId` = `""`（不按频道过滤）
- `userId` = `userID`（**只发送给当前用户**）

**跨端同步**：当前用户的所有设备（Web、桌面、移动端）都会收到此事件。

#### 5.2.3 增量字段的设计意图

**为什么需要 `previous_unread_*` 字段？**

服务端测试代码揭示了答案 (`server/channels/api4/user_test.go:7725-7748`):

```go
// 测试：标已读场景
t.Run("Listed for read event", func(t *testing.T) {
    // ...
    require.EqualValues(t, replyPost.CreateAt+1, data["timestamp"])
    require.EqualValues(t, float64(1), data["previous_unread_replies"])  // 之前有 1 条未读回复
    require.EqualValues(t, float64(1), data["previous_unread_mentions"]) // 之前有 1 个未读提及
    require.EqualValues(t, float64(0), data["unread_replies"])           // 之后有 0 条
    require.EqualValues(t, float64(0), data["unread_mentions"])          // 之后有 0 个
})

// 测试：标未读场景
t.Run("Listen for read event 2", func(t *testing.T) {
    // ...
    require.EqualValues(t, rpost.CreateAt-1, data["timestamp"])           // 时间戳回退
    require.EqualValues(t, float64(0), data["previous_unread_replies"])  // 之前有 0 条
    require.EqualValues(t, float64(0), data["previous_unread_mentions"]) // 之前有 0 个
    require.EqualValues(t, float64(1), data["unread_replies"])           // 之后有 1 条
    require.EqualValues(t, float64(1), data["unread_mentions"])          // 之后有 1 个
})
```

**设计意图**：

| 场景 | `previous_unread_replies` | `unread_replies` | 客户端行为 |
|------|---------------------------|------------------|------------|
| **标已读** | `1` | `0` | 未读计数**减少**1，执行"已读"动画 |
| **标未读** | `0` | `1` | 未读计数**增加**1，执行"未读"动画 |

客户端可以通过比较 `previous_unread_*` 和 `unread_*` 来：
1. 计算增量变化（`delta = unread - previous`）
2. 决定显示"已读"还是"未读"动画
3. 无需重新拉取完整的线程列表

### 5.3 与频道级事件的对比

#### 5.3.1 事件载荷对比

| 字段 | `thread_read_changed` (链路 C/D) | `post_unread` (链路 B) | `multiple_channels_viewed` (链路 A) |
|------|-----------------------------------|-------------------------|---------------------------------------|
| `thread_id` | ✅ 有 | ❌ 无 | ❌ 无 |
| `timestamp` | ✅ 有 | ✅ 有 (`last_viewed_at`) | ✅ 有 (`channel_times` 映射) |
| `unread_mentions` | ✅ 有 | ✅ 有 (`mention_count`) | ❌ 无 |
| `unread_replies` | ✅ 有 | ❌ 无 | ❌ 无 |
| `previous_unread_mentions` | ✅ 有 | ❌ 无 | ❌ 无 |
| `previous_unread_replies` | ✅ 有 | ❌ 无 | ❌ 无 |
| `channel_id` | ✅ 有 | ✅ 有 (广播范围) | ❌ 无 (映射键) |
| `post_id` | ❌ 无 | ✅ 有 | ❌ 无 |
| `msg_count` | ❌ 无 | ✅ 有 | ❌ 无 |
| `urgent_mention_count` | ❌ 无 | ✅ 有 | ❌ 无 |

#### 5.3.2 设计差异分析

| 维度 | 线程级事件 (`thread_read_changed`) | 频道级事件 |
|------|------------------------------------|------------|
| **设计目标** | CRT 视图的增量更新 | 传统视图的完整状态同步 |
| **增量字段** | 有 `previous_unread_*` | 无 |
| **粒度** | 单线程 | 单频道 或 多频道批量 |
| **依赖关系** | 不影响频道级状态 | 可能触发线程级更新（链路 B 中的 `thread_updated`） |

---

## 6. Webapp 事件处理与跨端收敛

### 6.1 事件到 Action 的映射

**WebSocket 事件接收** (`webapp/channels/src/actions/websocket_actions.ts`):

虽然 `thread_read_changed` 的具体处理逻辑需要查看完整代码，但从 `threads.ts` 中可以推断处理流程：

**关键 Action 类型** (`webapp/channels/src/packages/mattermost-redux/src/action_types/threads.ts`):

```typescript
export default keyMirror({
    RECEIVED_THREAD: null,
    RECEIVED_THREADS: null,
    RECEIVED_UNREAD_THREADS: null,
    FOLLOW_CHANGED_THREAD: null,
    READ_CHANGED_THREAD: null,        // 关键！对应 thread_read_changed 事件
    ALL_TEAM_THREADS_READ: null,
    DECREMENT_THREAD_COUNTS: null,
    RECEIVED_THREAD_COUNTS: null,
});
```

### 6.2 Action 处理逻辑

**handleReadChanged** (`webapp/channels/src/packages/mattermost-redux/src/actions/threads.ts:332-371`):

```typescript
export function handleReadChanged(
    threadId: string,
    teamId: string,
    channelId: string,
    {
        lastViewedAt,
        prevUnreadMentions,
        newUnreadMentions,
        prevUnreadReplies,
        newUnreadReplies,
    }: {
        lastViewedAt: number;
        prevUnreadMentions: number;
        newUnreadMentions: number;
        prevUnreadReplies: number;
        newUnreadReplies: number;
    },
): ActionFunc {
    return (dispatch, getState) => {
        const state = getState();
        const channel = getChannel(state, channelId);
        const thread = getThreadSelector(state, threadId);

        return dispatch({
            type: ThreadTypes.READ_CHANGED_THREAD,
            data: {
                id: threadId,
                teamId,
                channelId,
                lastViewedAt,
                prevUnreadMentions,    // 传递之前的值
                newUnreadMentions,     // 传递新值
                prevUnreadReplies,     // 传递之前的值
                newUnreadReplies,      // 传递新值
                channelType: channel?.type,
                isUrgent: thread?.is_urgent,
            },
        });
    };
}
```

### 6.3 Reducer 处理逻辑

**unreadThreadsInTeamReducer** (`webapp/channels/src/packages/mattermost-redux/src/reducers/entities/threads/threadsInTeam.ts:267-312`):

```typescript
export const unreadThreadsInTeamReducer = (
    state: ThreadsState['unreadThreadsInTeam'] = {}, 
    action: MMReduxAction, 
    extra: ExtraData
) => {
    switch (action.type) {
    case ThreadTypes.READ_CHANGED_THREAD: {
        const {teamId} = action.data;
        
        // 如果 teamId 为空，更新所有团队
        if (teamId === '') {
            const teamIds = Object.keys(state);
            let newState = {...state};
            for (const teamId of teamIds) {
                newState = handleSingleTeamThreadRead(newState, action, teamId, extra);
            }
            return newState;
        }
        
        // 否则更新指定团队
        return handleSingleTeamThreadRead(state, action, teamId, extra);
    }
    // ... 其他 case
    }
    return state;
};
```

**handleSingleTeamThreadRead** (`threadsInTeam.ts:200-244`):

```typescript
function handleSingleTeamThreadRead(
    state: ThreadsState['unreadThreadsInTeam'],
    action: AnyAction,
    teamId: string,
    extra: ExtraData
) {
    const {
        id,                    // threadId
        newUnreadMentions,
        newUnreadReplies,
    } = action.data;
    
    const team = state[teamId] || [];
    const index = team.indexOf(id);
    
    // 情况 1：线程不在未读列表中
    if (index === -1) {
        const thread = extra.threads[id];
        
        // 如果现在有未读，且线程较新，添加到未读列表
        if (thread && (newUnreadReplies > 0 || newUnreadMentions > 0)) {
            if (shouldAddThreadId(team, thread, extra.threads)) {
                return {
                    ...state,
                    [teamId]: [
                        ...team,
                        id,  // 添加到未读列表（标未读场景）
                    ],
                };
            }
        }
        // 否则什么也不做（已经是已读状态）
        return state;
    }
    
    // 情况 2：线程已在未读列表中
    
    // 如果仍然有未读，保持不变
    if (newUnreadReplies > 0 || newUnreadMentions > 0) {
        return state;
    }
    
    // 如果现在没有未读，从未读列表中移除（标已读场景）
    return {
        ...state,
        [teamId]: [
            ...team.slice(0, index),
            ...team.slice(index + 1),  // 移除
        ],
    };
}
```

### 6.4 跨端收敛逻辑

#### 6.4.1 状态机

根据 `handleSingleTeamThreadRead` 的逻辑，可以抽象出以下状态机：

```
                    ┌─────────────────┐
                    │   初始状态      │
                    │ (不在未读列表)   │
                    └────────┬────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │ 收到 READ_CHANGED_THREAD 事件 │
              └──────────────┬───────────────┘
                             │
              ┌──────────────┴───────────────┐
              │ newUnreadReplies > 0 或      │
              │ newUnreadMentions > 0 ?      │
              └──────────────┬───────────────┘
                    是 │              │ 否
                       │              │
                       ▼              ▼
              ┌─────────────┐    ┌─────────────┐
              │  标未读场景  │    │  标已读场景  │
              │             │    │             │
              │ 添加到      │    │ 从列表移除  │
              │ 未读列表    │    │ (已经不在)   │
              └─────────────┘    └─────────────┘
```

#### 6.4.2 增量同步 vs 完整同步

| 同步方式 | 触发时机 | 数据来源 | 可靠性 |
|----------|----------|----------|--------|
| **增量同步** | 收到 `thread_read_changed` 事件 | `previous_unread_*` 和 `unread_*` | 高（事件内包含完整状态） |
| **完整同步** | 重新进入团队/页面刷新 | API 调用 `getCountsAndThreadsSince` | 最高（从服务端拉取最新状态） |

**设计亮点**：

`thread_read_changed` 事件同时包含：
1. **新状态**：`unread_replies`, `unread_mentions`
2. **旧状态**：`previous_unread_replies`, `previous_unread_mentions`

这意味着：
- **客户端不需要计算**：直接使用 `unread_*` 更新本地状态
- **但可以计算增量**：用于 UI 动画和日志记录
- **跨端一致性**：所有设备收到相同的事件数据，状态自然一致

#### 6.4.3 与频道级路径的关系

**关键发现**：线程级操作（链路 C、D）**不影响**频道级未读状态。

验证依据：
1. `UpdateThreadReadForUser` 只更新 `ThreadMemberships` 表
2. 不更新 `ChannelMembers` 表的 `LastViewedAt` 或 `MsgCount`
3. 不发送频道级事件（`multiple_channels_viewed`, `post_unread` 等）

**反之亦然**：
- 频道级标已读（链路 A）**可能**触发线程级更新（`thread_read_changed` 事件）
- 但仅在 `updateThreads && isCRTEnabled` 的条件下

**关系图**：

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户操作                                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
┌───────────────────┐           ┌───────────────────┐
│   频道级操作       │           │   线程级操作       │
│   (链路 A、B)      │           │   (链路 C、D)      │
└─────────┬─────────┘           └─────────┬─────────┘
          │                               │
          │ 可能触发（条件）               │ 不影响
          ▼                               ▼
┌───────────────────┐           ┌───────────────────┐
│  ChannelMembers   │           │ ThreadMemberships │
│  (频道级未读状态)  │◄──────────│  (线程级未读状态)  │
└───────────────────┘   不影响   └───────────────────┘
```

---

## 7. 服务端测试验证

### 7.1 测试用例分析

**测试文件**：`server/channels/api4/user_test.go:7721-7802`

#### 7.1.1 标已读测试

```go
_, resp, err = th.Client.UpdateThreadReadForUser(
    context.Background(), 
    th.BasicUser.Id, 
    th.BasicTeam.Id, 
    rpost.Id, 
    replyPost.CreateAt+1  // 传入较新的时间戳
)

t.Run("Listed for read event", func(t *testing.T) {
    // ...
    data := ev.GetData()
    
    // 验证时间戳正确传递
    require.EqualValues(t, replyPost.CreateAt+1, data["timestamp"])
    
    // 验证增量字段正确
    require.EqualValues(t, float64(1), data["previous_unread_replies"])  // 之前有 1 条
    require.EqualValues(t, float64(1), data["previous_unread_mentions"]) // 之前有 1 个
    
    // 验证新状态正确
    require.EqualValues(t, float64(0), data["unread_replies"])           // 之后有 0 条
    require.EqualValues(t, float64(0), data["unread_mentions"])          // 之后有 0 个
})
```

#### 7.1.2 标未读测试

```go
_, resp, err = th.Client.SetThreadUnreadByPostId(
    context.Background(), 
    th.BasicUser.Id, 
    th.BasicTeam.Id, 
    rpost.Id, 
    rpost.Id  // 传入帖子 ID
)

t.Run("Listen for read event 2", func(t *testing.T) {
    // ...
    data := ev.GetData()
    
    // 验证时间戳被正确转换为 post.CreateAt - 1
    require.EqualValues(t, rpost.CreateAt-1, data["timestamp"])
    
    // 验证增量字段正确
    require.EqualValues(t, float64(0), data["previous_unread_replies"])  // 之前有 0 条
    require.EqualValues(t, float64(0), data["previous_unread_mentions"]) // 之前有 0 个
    
    // 验证新状态正确
    require.EqualValues(t, float64(1), data["unread_replies"])           // 之后有 1 条
    require.EqualValues(t, float64(1), data["unread_mentions"])          // 之后有 1 个
})
```

### 7.2 测试验证的结论

| 验证点 | 测试结果 | 设计意图 |
|--------|----------|----------|
| **标已读时间戳** | `replyPost.CreateAt + 1` 正确传递 | 时间戳向前推进 |
| **标未读时间戳** | `rpost.CreateAt - 1` 正确转换 | 时间戳向后回退 |
| **增量字段** | `previous_unread_*` 与 `unread_*` 配对正确 | 客户端可计算变化量 |
| **事件类型** | 两种场景都发送 `ThreadReadChanged` | 统一事件类型，客户端判断语义 |

---

## 8. 完整链路对比总结

### 8.1 入口对比

| 维度 | 链路 A：频道级标已读 | 链路 B：频道级标未读 | 链路 C：线程级标已读 | 链路 D：按帖子标线程未读 |
|------|----------------------|----------------------|----------------------|--------------------------|
| **API 方法** | POST | POST | PUT | POST |
| **端点** | `/channels/members/me/view` | `/users/{uid}/posts/{pid}/set_unread` | `/users/{uid}/teams/{tid}/threads/{thid}/read/{ts}` | `/users/{uid}/teams/{tid}/threads/{thid}/set_unread/{pid}` |
| **关键参数** | `channel_id`, `prev_channel_id` | `post_id` | `timestamp` | `post_id` |
| **触发场景** | 切换/进入频道 | 右键"标记为未读" | 查看线程、滚动到底部 | 右键线程"标记为未读" |

### 8.2 状态持久化对比

| 维度 | 链路 A | 链路 B | 链路 C | 链路 D |
|------|--------|--------|--------|--------|
| **影响表** | `ChannelMembers` (+ 可选 `ThreadMemberships`) | `ChannelMembers` (+ 可选 `ThreadMemberships`) | `ThreadMemberships` | `ThreadMemberships` |
| **关键字段** | `LastViewedAt = LastPostAt` | `LastViewedAt = post.CreateAt - 1` | `LastViewed = timestamp` | `LastViewed = post.CreateAt - 1` |
| **计数策略** | `MentionCount = 0` | `MentionCount = 计算值` | `UnreadMentions = countThreadMentions(ts)` | `UnreadMentions = countThreadMentions(ts)` |
| **前置条件** | 无 | 无 | 必须有线程成员关系 | 必须关注线程（强制设置） |
| **时间戳方向** | 向前（最新） | 向后（回退） | 向前（任意） | 向后（回退） |

### 8.3 事件推送对比

| 维度 | 链路 A | 链路 B | 链路 C | 链路 D |
|------|--------|--------|--------|--------|
| **事件类型 1** | `multiple_channels_viewed` (可选) | `post_unread` | `thread_read_changed` | `thread_read_changed` |
| **事件类型 2** | `thread_read_changed` (可选) | `thread_updated` (可选) | - | - |
| **广播范围** | 当前用户所有设备 | 当前用户所有设备 | 当前用户所有设备 | 当前用户所有设备 |
| **增量字段** | ❌ 无 | ❌ 无 | ✅ `previous_unread_*` | ✅ `previous_unread_*` |
| **完整状态** | 最小化（仅时间戳） | 完整（所有字段） | 完整（所有字段） | 完整（所有字段） |

### 8.4 跨端收敛对比

| 维度 | 链路 A | 链路 B | 链路 C | 链路 D |
|------|--------|--------|--------|--------|
| **收敛方式** | 时间戳驱动 | 完整状态驱动 | 完整状态 + 增量字段 | 完整状态 + 增量字段 |
| **客户端计算** | 需要本地计算未读数 | 直接使用服务端值 | 直接使用服务端值 | 直接使用服务端值 |
| **UI 动画** | 不支持 | 不支持 | 支持（通过 `previous_unread_*`） | 支持（通过 `previous_unread_*`） |
| **与频道级关系** | 独立 | 独立 | 不影响频道级 | 不影响频道级 |
| **与线程级关系** | 可能触发线程级 | 可能触发线程级 | 独立 | 独立 |

---

## 9. 关键架构洞察

### 9.1 四层未读状态模型

Mattermost 实际上维护了**四层独立的未读状态**：

```
┌─────────────────────────────────────────────────────────────────┐
│                         未读状态模型                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Level 4: 视觉未读指示器                                   │   │
│  │ - 客户端本地状态                                          │   │
│  │ - "新消息"分隔线位置                                      │   │
│  │ - 闪烁/高亮动画状态                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│                              │ 事件驱动                         │
│  ┌──────────────────────────┴──────────────────────────────┐   │
│  │ Level 3: WebSocket 事件                                 │   │
│  │ - multiple_channels_viewed                              │   │
│  │ - post_unread                                           │   │
│  │ - thread_read_changed (链路 C、D 统一事件)              │   │
│  │ - thread_updated                                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│                              │ API 操作                         │
│  ┌──────────────────────────┴──────────────────────────────┐   │
│  │ Level 2: 线程级未读 (ThreadMemberships)                  │   │
│  │ - LastViewed: 最后查看时间                               │   │
│  │ - UnreadMentions: 未读提及数                             │   │
│  │ - Following: 是否关注                                    │   │
│  │ - 链路 C、D 只影响这一层                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│                              │ 可能触发                        │
│  ┌──────────────────────────┴──────────────────────────────┐   │
│  │ Level 1: 频道级未读 (ChannelMembers)                     │   │
│  │ - LastViewedAt: 最后查看时间                             │   │
│  │ - MsgCount: 已读消息数                                   │   │
│  │ - MentionCount: 未读提及数                               │   │
│  │ - 链路 A、B 影响这一层                                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 统一事件设计

**最关键的架构洞察**：

链路 C（线程级标已读）和链路 D（按帖子标线程未读）使用**完全相同**的：
- 底层函数：`UpdateThreadReadForUser`
- WebSocket 事件：`WebsocketEventThreadReadChanged`
- 事件载荷字段

**区别仅在于**：
- **时间戳方向**：标已读用较大值，标未读用较小值
- **计数结果**：`unread_replies` 和 `unread_mentions` 的值

**设计优势**：

1. **简化服务端代码**：一个函数处理两种语义
2. **简化客户端处理**：一种事件类型，通过比较 `previous_unread_*` 和 `unread_*` 判断语义
3. **增量更新能力**：客户端可以计算变化量，执行平滑动画
4. **状态一致性**：事件携带完整状态，客户端无需额外计算

### 9.3 层级隔离设计

**线程级操作与频道级操作的隔离**：

| 操作方向 | 是否影响 |
|----------|----------|
| 频道级操作 → 线程级状态 | **可能影响**（有条件） |
| 线程级操作 → 频道级状态 | **不影响**（完全隔离） |

**设计意图**：
- CRT 视图是一个"可选"的视图模式
- 用户可以在 CRT 和传统视图之间切换
- 线程级操作不应该破坏传统视图的未读状态
- 但频道级操作（如"全部标为已读"）应该影响所有视图

---

## 10. 代码位置索引

### 10.1 线程级链路

| 功能 | 文件路径 | 行号 |
|------|----------|------|
| 线程级标已读 API | `server/channels/api4/user.go` | 3739 |
| 按帖子标线程未读 API | `server/channels/api4/user.go` | 3752 |
| UpdateThreadReadForUser | `server/channels/app/user.go` | 3100 |
| UpdateThreadReadForUserByPost | `server/channels/app/user.go` | 3087 |
| MarkAsRead (存储) | `server/channels/store/sqlstore/thread_store.go` | 684 |
| ThreadReadChanged 事件 | `server/public/model/websocket_message.go` | 77 |
| 服务端测试 | `server/channels/api4/user_test.go` | 7721 |

### 10.2 Webapp 端

| 功能 | 文件路径 | 行号 |
|------|----------|------|
| READ_CHANGED_THREAD Action | `webapp/channels/src/packages/mattermost-redux/src/action_types/threads.ts` | 11 |
| handleReadChanged | `webapp/channels/src/packages/mattermost-redux/src/actions/threads.ts` | 332 |
| unreadThreadsInTeamReducer | `webapp/channels/src/packages/mattermost-redux/src/reducers/entities/threads/threadsInTeam.ts` | 267 |
| handleSingleTeamThreadRead | `webapp/channels/src/packages/mattermost-redux/src/reducers/entities/threads/threadsInTeam.ts` | 200 |

### 10.3 频道级链路（回顾）

| 功能 | 文件路径 | 行号 |
|------|----------|------|
| ViewChannel | `server/channels/app/channel.go` | 3390 |
| MarkChannelsAsViewed | `server/channels/app/channel.go` | 3331 |
| MarkChannelAsUnreadFromPost | `server/channels/app/channel.go` | 3031 |
| markChannelAsUnreadFromPostCRTUnsupported | `server/channels/app/channel.go` | 3062 |

---

## 11. 附录：时序图

### 11.1 线程级标已读时序

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ 客户端 A │         │  API 层  │         │  App 层  │         │  存储层  │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │ PUT /users/uid/teams/tid/threads/thid/read/1704067200000    │
     │ (timestamp = 最新时间)                    │                     │
     │────────────────────>│                     │                     │
     │                     │                     │                     │
     │                     │ UpdateThreadReadForUser(uid, tid, timestamp=1704067200000)
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │                     │ 1. GetThreadMembershipForUser
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ membership (包含 previous_unread_*)
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │                     │ 2. GetThreadUnreadReplyCount
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ previous_unread_replies = 1
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │                     │ 3. countThreadMentions(timestamp)
     │                     │                     │                     │
     │                     │                     │    (返回 0，因为 timestamp 很新)
     │                     │                     │                     │
     │                     │                     │ 4. UpdateMembership
     │                     │                     │    UnreadMentions = 0
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ 5. MarkAsRead
     │                     │                     │    LastViewed = 1704067200000
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ 6. 发送 WebsocketEventThreadReadChanged
     │                     │                     │                     │
     │                     │                     │    thread_id: thid
     │                     │                     │    timestamp: 1704067200000
     │                     │                     │    unread_replies: 0
     │                     │                     │    unread_mentions: 0
     │                     │                     │    previous_unread_replies: 1
     │                     │                     │    previous_unread_mentions: 1
     │                     │<───────────────────────────────────────────│ (客户端 A 所有设备)
     │                     │                     │                     │
     │                     │ 200 OK { ThreadResponse }                 │
     │<────────────────────│                     │                     │
     │                     │                     │                     │
```

### 11.2 按帖子标线程未读时序

```
┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ 客户端 A │         │  API 层  │         │  App 层  │         │  存储层  │
└────┬─────┘         └────┬─────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │ POST /users/uid/teams/tid/threads/thid/set_unread/post_123   │
     │ (post_id = 锚点帖子)                    │                     │
     │────────────────────>│                     │                     │
     │                     │                     │                     │
     │                     │ 1. UpdateThreadFollowForUser(..., true)  │
     │                     │    (强制关注线程)   │                     │
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │ 2. UpdateThreadReadForUserByPost(uid, tid, post_123)
     │                     │────────────────────>│                     │
     │                     │                     │                     │
     │                     │                     │ 2.1 GetSinglePost(post_123)
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ post (CreateAt = 1704067100000)
     │                     │                     │<────────────────────│
     │                     │                     │                     │
     │                     │                     │ 2.2 验证 post.RootId == tid || post.Id == tid
     │                     │                     │                     │
     │                     │                     │ 2.3 转换: timestamp = post.CreateAt - 1
     │                     │                     │                     │
     │                     │                     │     = 1704067099999
     │                     │                     │                     │
     │                     │                     │ 2.4 调用 UpdateThreadReadForUser(..., 1704067099999)
     │                     │                     │                     │
     │                     │                     │ 3. countThreadMentions(1704067099999)
     │                     │                     │                     │
     │                     │                     │    (返回 > 0，因为有帖子在这个时间之后)
     │                     │                     │                     │
     │                     │                     │ 4. MarkAsRead
     │                     │                     │    LastViewed = 1704067099999 (回退！)
     │                     │                     │────────────────────>│
     │                     │                     │                     │
     │                     │                     │ 5. 发送 WebsocketEventThreadReadChanged
     │                     │                     │                     │
     │                     │                     │    thread_id: thid
     │                     │                     │    timestamp: 1704067099999 (注意：较小的值)
     │                     │                     │    unread_replies: 1
     │                     │                     │    unread_mentions: 1
     │                     │                     │    previous_unread_replies: 0
     │                     │                     │    previous_unread_mentions: 0
     │                     │<───────────────────────────────────────────│ (客户端 A 所有设备)
     │                     │                     │                     │
     │                     │ 200 OK { ThreadResponse }                 │
     │<────────────────────│                     │                     │
     │                     │                     │                     │
```

---

*分析日期：2026-05-02*
*基于 Mattermost 代码库版本：v8.x*

---

## 修订说明

本文档是 `post-reply-analysis-r2.md` 的修订版，主要补充：

1. **新增两条线程级链路**：
   - 链路 C：线程级标已读 (`UpdateThreadReadForUser`)
   - 链路 D：按帖子标线程未读 (`UpdateThreadReadForUserByPost`)

2. **关键洞察**：
   - 链路 C 和 D 使用相同的底层函数和事件
   - 仅时间戳方向不同：标已读向前，标未读向后
   - 事件携带增量字段 `previous_unread_*` 用于 UI 动画

3. **与频道级链路的关系**：
   - 线程级操作**不影响**频道级状态
   - 频道级操作**可能影响**线程级状态（有条件）
   - 四层未读状态模型：频道级 → 线程级 → 事件 → 视觉指示器
