# Mattermost 权限模型补充分析报告

> 分析日期: 2026-05-02
> 分析范围: 当前仓库源码 (`api/v4/source/*.yaml`)
> 仓内找不到的内容标注为 **「仅文档描述」**
> 本文档补充主报告中未覆盖的内容：访客角色、状态变更联动、管理员例外分支、辅助权限接口

---

## 一、访客角色 (Guest) 与普通成员的差异

### 1.1 访客角色的标识字段

#### 团队级访客标识

**源码位置**: `api/v4/source/teams.yaml:1607`

```yaml
Each user object contains the boolean fields `scheme_guest`, `scheme_user`, and `scheme_admin` representing the roles that user has for the given team.
```

**源码位置**: `api/v4/source/channels.yaml:2283`

```yaml
Each user object contains the boolean fields `scheme_guest`, `scheme_user`, and `scheme_admin` representing the roles that user has for the given channel.
```

#### 访客角色字段说明

| 字段 | 作用域 | 说明 | 源码位置 |
|------|--------|------|----------|
| `scheme_guest` | 团队级 | 标记用户在特定团队中是否持有访客角色 | `teams.yaml:1607` |
| `scheme_guest` | 频道级 | 标记用户在特定频道中是否持有访客角色 | `channels.yaml:2283` |
| `scheme_user` | 团队/频道级 | 标记是否持有方案派生的普通用户角色 | `teams.yaml:1607` |
| `scheme_admin` | 团队/频道级 | 标记是否持有方案派生的管理员角色 | `teams.yaml:1607` |

### 1.2 访客角色的权限限制

#### DM/GM 频道限制

**源码位置**: `api/v4/source/bookmarks.yaml:54, 127, 206, 253`

```yaml
type. If the channel is a DM or GM, must be a non-guest
```

**源码位置**: `api/v4/source/bookmarks.yaml:1` (GetBookmark)

```yaml
"/api/v4/channels/{channel_id}/bookmarks/{bookmark_id}":
  get:
    summary: Get bookmark
    description: >
      ##### Permissions
      Must have `read_channel` permission for the channel.
      Must be a member of the channel.
      If the channel is a DM or GM, must be a non-guest.
```

#### 访客权限限制总结

| 限制项 | 说明 | 源码位置 |
|--------|------|----------|
| DM/GM 频道操作 | 访客不能在私聊/群聊频道中进行某些操作（如书签管理） | `bookmarks.yaml:54, 127, 206, 253` |
| 角色标识 | 通过 `scheme_guest` 字段与普通成员区分 | `teams.yaml:1607` |

### 1.3 访客角色的角色名推断

**仅文档描述**: 基于 API 定义推断，访客角色名应为：
- **系统级**: `system_guest`
- **团队级**: `team_guest`
- **频道级**: `channel_guest`

**仓内源码证据说明**: 仓内 API 定义中仅通过 `scheme_guest` 字段标识访客状态，未直接出现 `team_guest` 或 `channel_guest` 角色名字符串。角色名定义位于外部依赖 `model/role.go` 中。

### 1.4 访客角色与普通成员的权限对比

**仅文档描述**: 基于 Mattermost 架构推断：

| 维度 | 普通成员 (User) | 访客 (Guest) |
|------|-----------------|--------------|
| 团队访问 | 可访问所有开放频道 | 只能访问显式加入的频道 |
| 频道创建 | 可创建公开/私密频道 | 通常受限 |
| 成员邀请 | 可邀请其他成员 | 通常受限 |
| DM/GM | 可自由发起私聊/群聊 | 受限（仓内源码已验证） |
| 成员管理 | 部分管理权限 | 无 |
| 角色标识 | `scheme_user=true` | `scheme_guest=true` |

---

## 二、访客与成员状态变更的权限联动

### 2.1 降级为访客 (Demote to Guest)

**源码位置**: `api/v4/source/users.yaml:1580-1618`

```yaml
"/api/v4/users/{user_id}/demote":
  post:
    summary: Demote a user to a guest
    description: |
      Convert a regular user into a guest. This will convert the user into a
      guest for the whole system while retaining their existing team and
      channel memberships.

      __Minimum server version__: 5.16

      ##### Permissions
      Must be logged in as the user or have the `demote_to_guest` permission.
    operationId: DemoteUserToGuest
    parameters:
      - name: user_id
        in: path
        description: User GUID
        required: true
        schema:
          type: string
    responses:
      "200":
        description: User successfully demoted
```

#### 降级权限联动影响

| 变更项 | 说明 | 源码证据 |
|--------|------|----------|
| 角色转换 | 普通用户 → 访客（系统级） | `users.yaml:1586` |
| 成员保留 | 保留现有团队和频道成员身份 | `users.yaml:1587` |
| 权限限制 | 访客权限限制生效 | 「仅文档描述」 |

### 2.2 提升为普通用户 (Promote to User)

**源码位置**: `api/v4/source/users.yaml:1619-1657`

```yaml
"/api/v4/users/{user_id}/promote":
  post:
    summary: Promote a guest to user
    description: |
      Convert a guest into a regular user. This will convert the guest into a
      user for the whole system while retaining any team and channel
      memberships and automatically joining them to the default channels.

      __Minimum server version__: 5.16

      ##### Permissions
      Must be logged in as the user or have the `promote_guest` permission.
    operationId: PromoteGuestToUser
    responses:
      "200":
        description: Guest successfully promoted
```

#### 提升权限联动影响

| 变更项 | 说明 | 源码证据 |
|--------|------|----------|
| 角色转换 | 访客 → 普通用户（系统级） | `users.yaml:1625` |
| 成员保留 | 保留现有团队和频道成员身份 | `users.yaml:1626` |
| 自动加入 | 自动加入默认频道 | `users.yaml:1627` |
| 权限恢复 | 恢复普通用户权限 | 「仅文档描述」 |

### 2.3 邀请访客 (Invite Guest)

**源码位置**: `api/v4/source/teams.yaml:1347-1435`

```yaml
"/api/v4/teams/{team_id}/invite-guests/email":
  post:
    summary: Invite guests to the team by email
    description: >
      Invite guests to existing team channels usign the user's email.

      ##### Permissions
      Must have `invite_guest` permission for the team.
    operationId: InviteGuestsToTeam
    parameters:
      - name: guest_magic_link
        in: query
        description: If true, invites guests with magic link (passwordless) authentication. Requires guest magic link feature to be enabled.
        schema:
          type: boolean
          default: false
```

#### 邀请访客的特殊机制

| 特性 | 说明 | 源码位置 |
|------|------|----------|
| 无密码邀请 | 支持通过 magic link 邀请（免密码） | `teams.yaml:1375-1377` |
| 频道指定 | 可指定邀请到特定频道 | `teams.yaml:1353` |
| 权限要求 | 需要 `invite_guest` 权限 | `teams.yaml:1360` |

### 2.4 访客登录 (Magic Link)

**源码位置**: `api/v4/source/users.yaml:31`

```yaml
"/api/v4/users/login":
  post:
    requestBody:
      content:
        application/json:
          schema:
            type: object
            properties:
              magic_link_token:
                type: string
                description: Magic link token for passwordless guest authentication. When provided, authenticates the user using the magic link token instead of password. Requires guest magic link feature to be enabled.
```

**源码位置**: `api/v4/source/users.yaml:2275`

```yaml
The authentication service type. Returns the actual service type if guest_magic_link is enabled (in which case a magic link is also sent to the user's email). Returns an empty string for all other authentication methods.
```

### 2.5 用户查询中的访客过滤

**源码位置**: `api/v4/source/users.yaml:535, 547, 934, 943`

```yaml
Example: `?in_channel=4eb6axxw7fg3je5iyasnfudc5y&channel_roles=channel_user` will return users that are only channel users and not admins or guests

Example: `?in_team=4eb6axxw7fg3je5iyasnfudc5y&team_roles=team_user` will return users that are only team users and not admins or guests
```

#### 过滤参数说明

| 参数 | 说明 | 示例 | 源码位置 |
|------|------|------|----------|
| `channel_roles` | 按频道角色过滤 | `channel_roles=channel_user`（排除访客和管理员） | `users.yaml:535` |
| `team_roles` | 按团队角色过滤 | `team_roles=team_user`（排除访客和管理员） | `users.yaml:547` |

### 2.6 LDAP 访客过滤

**源码位置**: `api/v4/source/definitions.yaml:1424-1425`

```yaml
GuestFilter:
  type: string
```

LDAP 配置中支持 `GuestFilter` 字段，用于从 LDAP 同步访客用户。

---

## 三、授权链路中的管理员例外分支

### 3.1 权限校验模式分类

根据仓内源码分析，Mattermost 权限校验存在多种例外分支模式：

| 模式 | 说明 | 示例 |
|------|------|------|
| **自我豁免** | 用户可以操作自己的资源 | "Must be logged in as the user" |
| **权限或豁免** | 有特定权限 或 是资源所有者 | "Must be logged in as the user or have X permission" |
| **超级权限豁免** | `manage_system` 权限可绕过所有限制 | "Must have `manage_system` permission" |
| **组合权限** | 多个权限满足其一即可 | "Must have `manage_team` or `manage_system` permissions" |
| **多级权限** | 需要多个权限同时满足 | "Must have `read_channel` and `view_team` permissions" |

### 3.2 自我豁免模式 (Self-Exemption)

#### 用户偏好操作

**源码位置**: `api/v4/source/preferences.yaml:11, 44, 89, 132, 173`

```yaml
##### Permissions
Must be logged in as the user being updated or have the `edit_other_users` permission.
```

#### 帖子删除

**源码位置**: `api/v4/source/posts.yaml:184`

```yaml
##### Permissions
Must be logged in as the user or have `delete_others_posts` permission.
```

#### 频道通知设置

**源码位置**: `api/v4/source/channels.yaml:1881`

```yaml
##### Permissions
Must be logged in as the user or have `edit_other_users` permission.
```

#### 自定义状态管理

**源码位置**: `api/v4/source/status.yaml:120, 167`

```yaml
##### Permissions
Must be logged in as the user whose custom status is being updated.
```

**注意**: 自定义状态操作**仅允许用户操作自己**，没有管理员例外分支。

### 3.3 超级权限豁免模式 (System Admin Exemption)

#### 角色管理

**源码位置**: `api/v4/source/roles.yaml:9, 103`

```yaml
##### Permissions
Must have `manage_system` permission.

##### Permissions
Must have `sysconsole_write_user_management_permissions` or `manage_system` permission.
```

#### 权限方案管理

**源码位置**: `api/v4/source/schemes.yaml:20, 42, 65, 88, 110, 133, 155, 178`

```yaml
##### Permissions
Must have `manage_system` permission.
```

#### 系统设置管理

**源码位置**: `api/v4/source/system.yaml:820`

```yaml
##### Permissions
Must have `manage_systems` permissions.
```

**注意**: `manage_systems` 可能是笔误，应为 `manage_system`。

#### 数据导入导出

**源码位置**: `api/v4/source/exports.yaml:13, 37, 69`

```yaml
##### Permissions
Must have `manage_system` permissions.
```

### 3.4 组合权限模式 (Combined Permissions)

#### 表情管理

**源码位置**: `api/v4/source/emoji.yaml:134`

```yaml
##### Permissions
Must have the `manage_team` or `manage_system` permissions or be the user who created the emoji.
```

#### 访客降级/提升

**源码位置**: `api/v4/source/users.yaml:1593, 1632`

```yaml
##### Permissions
Must be logged in as the user or have the `demote_to_guest` permission.

##### Permissions
Must be logged in as the user or have the `promote_guest` permission.
```

### 3.5 多级权限模式 (Multi-Level Permissions)

#### 帖子查询（结合上下文权限）

**源码位置**: `api/v4/source/posts.yaml:643, 989, 1032`

```yaml
##### Permissions
Must have `read_channel` permission for the channel the post is in.
Must be logged in as the user or have `edit_other_users` permission.

##### Permissions
Must have `read_channel` permission for the channel the post is in.
Must be logged in as the user or have `edit_other_users` permission.
The post must have been acknowledged in the previous 5 minutes.
```

#### 用户搜索（结合团队/频道权限）

**源码位置**: `api/v4/source/users.yaml:713`

```yaml
##### Permissions
Requires an active session and `read_channel` and/or `view_team` permissions for any channels or teams specified in the request body.
```

### 3.6 权限校验流程图解

**仅文档描述**: 基于 API 定义推断的权限校验链路：

```
请求到达
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 认证检查 (Authentication)                           │
│     - 验证会话是否有效                                         │
│     - 检查用户是否激活 (delete_at == 0)                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: 超级权限检查 (System Admin Exemption)               │
│     - 是否有 `manage_system` 权限？                           │
│     - 是 → 直接通过（跳过后续检查）                            │
│     - 否 → 继续检查                                           │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: 自我豁免检查 (Self-Exemption)                       │
│     - 是否是操作自己的资源？                                   │
│     - 是 → 检查是否允许自我操作                                │
│     - 否 → 继续检查                                           │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: 权限检查 (Authorization)                            │
│     - 检查是否具有所需权限                                      │
│     - 组合权限：满足任一即可                                   │
│     - 多级权限：需同时满足                                     │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
  通过或拒绝
```

### 3.7 权限校验模式汇总表

| 模式 | 权限表达式 | 示例端点 | 源码位置 |
|------|------------|----------|----------|
| **严格自我** | `self` | UpdateUserCustomStatus | `status.yaml:120` |
| **自我或权限** | `self ∨ permission` | DeletePost | `posts.yaml:184` |
| **权限或权限** | `perm1 ∨ perm2` | PatchRole | `roles.yaml:103` |
| **权限和权限** | `perm1 ∧ perm2` | GetPostsAroundLastUnread | `posts.yaml:643` |
| **严格权限** | `permission` | GetAllRoles | `roles.yaml:9` |
| **组合豁免** | `self ∨ (perm1 ∨ perm2)` | DeleteEmoji | `emoji.yaml:134` |

---

## 四、辅助权限接口

### 4.1 辅助权限接口定义

**源码位置**: `api/v4/source/permissions.yaml:1-30`

```yaml
/api/v4/permissions/ancillary:
  post:
    tags:
      - permissions
    summary: Return all system console subsection ancillary permissions
    description: >
      Returns all the ancillary permissions for the corresponding system console
      subsection permissions appended to the requested permission subsections.
      __Minimum server version__: 9.10
    operationId: GetAncillaryPermissionsPost
    requestBody:
      content:
        application/json:
          schema:
            type: array
            items:
              type: string
        description: List of subsection permissions
        required: true
    responses:
      "200":
        description: Successfully returned all ancillary and requested permissions
        content:
          application/json:
            schema:
              type: array
              items:
                type: string
```

### 4.2 辅助权限接口说明

| 属性 | 说明 |
|------|------|
| **端点** | `POST /api/v4/permissions/ancillary` |
| **功能** | 返回系统控制台子部分的辅助权限 |
| **请求体** | 子部分权限名称数组 |
| **响应** | 包含辅助权限在内的完整权限数组 |
| **最低版本** | 9.10 |

### 4.3 辅助权限的用途

**仅文档描述**: 基于接口名称和描述推断：

在 Mattermost 的权限体系中，某些"主权限"可能关联多个"辅助权限"。例如：
- 授予 `sysconsole_write_user_management_permissions` 权限时
- 可能同时需要授予相关的辅助权限才能完整功能

此接口用于查询：给定一组主权限，还需要哪些辅助权限？

### 4.4 辅助权限与主权限示例

**仅文档描述**: 基于 Mattermost 架构推断：

| 主权限 | 可能的辅助权限 |
|--------|----------------|
| `sysconsole_write_user_management_permissions` | `read_user`, `edit_user`, `manage_roles` 等 |
| `manage_team` | `view_team`, `add_user_to_team`, `remove_user_from_team` 等 |
| `manage_system` | 所有权限（超级权限） |

### 4.5 仓内其他权限相关接口

#### 无权限要求的接口

以下接口不需要特殊权限（仅需活跃会话或无任何权限）：

| 接口 | 权限要求 | 源码位置 |
|------|----------|----------|
| `GetRole` | Requires an active session but no other permissions | `roles.yaml:37` |
| `GetRoleByName` | Requires an active session but no other permissions | `roles.yaml:68` |
| `GetRolesByNames` | Requires an active session but no other permissions | `roles.yaml:153` |
| `GetUser` | Requires an active session but no other permissions | `users.yaml:592` |
| `GetMe` | Requires an active session but no other permissions | `users.yaml:640` |
| `DataRetentionPolicies` | Requires an active session but no other permissions | `dataretention.yaml:14` |

#### 无任何权限要求的接口（公开接口）

| 接口 | 权限要求 | 源码位置 |
|------|----------|----------|
| `Login` | No permission required | `users.yaml:1794` |
| `CheckMfa` | No permission required | `users.yaml:1706` |
| `GetPublicFile` | No permissions required | `files.yaml:302` |
| `GetPluginStatuses` | No permissions required | `plugins.yaml:268` |
| `GetWebappPlugins` | No permissions required | `plugins.yaml:298` |
| `SendResetPasswordEmail` | No permissions required | `users.yaml:2091` |
| `ResetPassword` | No permissions required | `users.yaml:2126` |

---

## 五、仓内源码证据与文档描述边界校对

### 5.1 已验证（仓内有源码证据）

#### 访客角色相关

| 结论 | 源码位置 |
|------|----------|
| 团队成员有 `scheme_guest` 字段标识访客状态 | `teams.yaml:1607` |
| 频道成员有 `scheme_guest` 字段标识访客状态 | `channels.yaml:2283` |
| 访客在 DM/GM 频道中有操作限制 | `bookmarks.yaml:54, 127, 206, 253` |
| 存在 `demote_to_guest` 权限 | `users.yaml:1593` |
| 存在 `promote_guest` 权限 | `users.yaml:1632` |
| 存在 `invite_guest` 权限 | `teams.yaml:1360` |
| 支持 magic link 无密码访客登录 | `users.yaml:31, 2275` |
| 用户查询支持按访客角色过滤 | `users.yaml:535, 547, 934, 943` |
| LDAP 配置支持 `GuestFilter` | `definitions.yaml:1424-1425` |

#### 状态变更联动相关

| 结论 | 源码位置 |
|------|----------|
| `DemoteUserToGuest` 降级为访客 | `users.yaml:1580-1618` |
| `PromoteGuestToUser` 提升为用户 | `users.yaml:1619-1657` |
| 降级时保留团队/频道成员身份 | `users.yaml:1587` |
| 提升时自动加入默认频道 | `users.yaml:1627` |
| `InviteGuestsToTeam` 邀请访客 | `teams.yaml:1347-1435` |

#### 管理员例外分支相关

| 结论 | 源码位置 |
|------|----------|
| "自我或权限"模式：`self ∨ permission` | `preferences.yaml:11`, `posts.yaml:184`, `channels.yaml:1881` |
| "严格自我"模式：仅允许操作自己 | `status.yaml:120, 167` |
| "严格权限"模式：`manage_system` 超级权限 | `roles.yaml:9`, `schemes.yaml:20` |
| "组合权限"模式：`perm1 ∨ perm2` | `roles.yaml:103`, `emoji.yaml:134` |
| "多级权限"模式：`perm1 ∧ perm2` | `posts.yaml:643`, `users.yaml:713` |

#### 辅助权限接口相关

| 结论 | 源码位置 |
|------|----------|
| `GetAncillaryPermissionsPost` 接口存在 | `permissions.yaml:1-30` |
| 公开接口无权限要求 | `users.yaml:1794, 1706`, `files.yaml:302` |
| 部分接口仅需活跃会话 | `roles.yaml:37, 68, 153`, `users.yaml:592, 640` |

### 5.2 仅文档描述（仓内无源码证据）

以下内容**不在当前仓库中**，核心实现位于外部依赖 `github.com/mattermost/mattermost/server/public/model`：

#### 访客角色相关

| 内容 | 说明 |
|------|------|
| `team_guest` 角色名定义 | 仓内仅通过 `scheme_guest` 字段标识，未出现角色名字符串 |
| `channel_guest` 角色名定义 | 同上 |
| `system_guest` 角色名定义 | 同上 |
| 访客权限的具体限制清单 | 仓内仅验证了 DM/GM 限制，其他限制需查看外部依赖 |
| 角色权限映射表 | 哪些角色拥有哪些权限的完整映射 |

#### 权限校验核心逻辑

| 内容 | 说明 |
|------|------|
| 权限校验中间件实现 | HTTP 请求层的权限检查代码 |
| 权限计算核心函数 | 如何计算用户有效权限集合 |
| 权限缓存机制 | 权限计算结果的缓存策略 |
| 权限继承逻辑 | 团队级权限如何继承到频道级 |

#### 数据模型完整定义

| 内容 | 说明 |
|------|------|
| `Role` 结构体完整定义 | 包含 `id`, `name`, `display_name`, `description`, `permissions`, `scheme_managed`, `built_in` 等字段 |
| `Permission` 结构体定义 | 权限常量定义 |
| `Scheme` 结构体完整定义 | 权限方案的完整结构 |

### 5.3 边界校对总结

| 类别 | 仓内有证据 | 仓内无证据（仅文档描述） |
|------|-----------|--------------------------|
| **API 端点定义** | ✅ 所有公开 API | ❌ |
| **权限要求定义** | ✅ 每个端点的 `##### Permissions` 小节 | ❌ |
| **数据结构字段** | ✅ `definitions.yaml` 中的字段定义 | ❌ |
| **角色名常量** | ❌ 仅出现部分（`system_user`, `team_user` 等） | ✅ `team_guest`, `channel_guest` 等角色名字符串未出现 |
| **权限常量** | ❌ 仅出现部分（`manage_system`, `view_team` 等） | ✅ 完整权限常量列表 |
| **核心实现逻辑** | ❌ | ✅ 权限校验、计算、缓存逻辑 |

---

## 六、补充报告总结

### 6.1 访客角色核心要点

| 维度 | 核心设计 | 源码证据 |
|------|----------|----------|
| **角色标识** | `scheme_guest` 字段（团队/频道级） | `teams.yaml:1607`, `channels.yaml:2283` |
| **状态转换** | `DemoteUserToGuest` / `PromoteGuestToUser` | `users.yaml:1580-1657` |
| **邀请机制** | `InviteGuestsToTeam` + Magic Link | `teams.yaml:1347-1435`, `users.yaml:31` |
| **权限限制** | DM/GM 频道操作受限 | `bookmarks.yaml:54, 127, 206, 253` |
| **权限要求** | `demote_to_guest`, `promote_guest`, `invite_guest` | `users.yaml:1593, 1632`, `teams.yaml:1360` |

### 6.2 管理员例外分支核心要点

| 模式 | 权限表达式 | 典型场景 |
|------|------------|----------|
| **严格自我** | `self` | 自定义状态管理 |
| **自我或权限** | `self ∨ permission` | 删除自己的帖子、修改自己的偏好 |
| **权限或权限** | `perm1 ∨ perm2` | 角色管理（系统管理员或权限管理员） |
| **权限和权限** | `perm1 ∧ perm2` | 帖子查询（需读取频道权限） |
| **严格权限** | `manage_system` | 系统级配置、权限方案管理 |

### 6.3 辅助权限接口核心要点

| 接口 | 用途 | 权限要求 |
|------|------|----------|
| `GetAncillaryPermissionsPost` | 查询主权限对应的辅助权限 | 仓内未明确说明，可能仅需活跃会话 |

### 6.4 仓内源码覆盖范围

本仓库提供的 API 定义覆盖了：

| 覆盖层 | 内容 |
|--------|------|
| **接口层** | 所有公开 API 的端点定义、请求/响应结构 |
| **权限声明层** | 每个端点的权限要求（`##### Permissions` 小节） |
| **数据模型层** | 核心数据结构的字段定义（`definitions.yaml`） |

本仓库**不包含**：

| 缺失层 | 内容 | 位置 |
|--------|------|------|
| **实现层** | 权限校验核心逻辑 | 外部依赖 `app/permissions.go` |
| **模型层** | 完整数据结构定义 | 外部依赖 `model/*.go` |
| **存储层** | 数据持久化逻辑 | 外部依赖 `store/*.go` |
| **常量层** | 完整权限/角色常量列表 | 外部依赖 `model/permission.go` |

---

*补充报告生成时间: 2026-05-02*
*主报告配套文档: `Mattermost权限模型分析报告.md`*
