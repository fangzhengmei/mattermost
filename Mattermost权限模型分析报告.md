# Mattermost 权限模型分析报告

> 分析日期: 2026-05-02
> 分析范围: 当前仓库源码 (`api/v4/source/*.yaml`)
> 仓内找不到的内容标注为 **「仅文档描述」**

---

## 一、仓库现状说明

### 1.1 源码可用性分析

当前仓库**并非完整的 Mattermost 服务器源码**，核心权限模型实现代码位于外部依赖。根据目录结构和文件搜索结果：

| 组件 | 状态 | 说明 |
|------|------|------|
| 核心权限模型代码 | **不在此仓库** | `model/role.go`、`model/permission.go`、`app/permissions.go` 等核心实现位于外部依赖 `github.com/mattermost/mattermost/server/public/model` |
| API 定义文件 | **存在** | `api/v4/source/*.yaml` 包含完整的 API 端点定义和权限要求 |
| 数据模型定义 | **存在** | `api/v4/source/definitions.yaml` 包含 `TeamMember`、`ChannelMember`、`User` 等数据结构 |
| 企业版接口定义 | **存在** | `server/einterfaces/*.go` 定义了企业版功能接口（部分为空文件） |

### 1.2 可用源码文件索引

| 文件路径 | 内容概要 |
|----------|----------|
| `api/v4/source/roles.yaml` | 角色 CRUD API，含 `GetAllRoles`、`GetRole`、`PatchRole` 等 |
| `api/v4/source/schemes.yaml` | 权限方案 API，含 `GetSchemes`、`CreateScheme`、`UpdateTeamScheme` 关联等 |
| `api/v4/source/teams.yaml` | 团队管理 API，含成员角色更新、方案角色更新等 |
| `api/v4/source/channels.yaml` | 频道管理 API，含成员批量设置、管理员角色变更等 |
| `api/v4/source/users.yaml` | 用户管理 API，含激活/停用、系统角色更新等 |
| `api/v4/source/definitions.yaml` | 数据模型定义，含 TeamMember、ChannelMember、User 等结构 |
| `api/v4/source/permissions.yaml` | 权限相关 API（尚未读取，但已推断其存在） |

---

## 二、成员角色定义

### 2.1 角色数据结构

#### TeamMember 结构（团队成员）

**源码位置**: `api/v4/source/definitions.yaml:742`

```yaml
TeamMember:
  type: object
  properties:
    team_id:
      description: The ID of the team this member belongs to.
      type: string
    user_id:
      description: The ID of the user this member relates to.
      type: string
    roles:
      description: The complete list of roles assigned to this team member, as a
        space-separated list of role names, including any roles granted
        implicitly through permissions schemes.
      type: string
    delete_at:
      description: The time in milliseconds that this team member was deleted.
      type: integer
    scheme_user:
      description: Whether this team member holds the default user role defined by the
        team's permissions scheme.
      type: boolean
    scheme_admin:
      description: Whether this team member holds the default admin role defined by the
        team's permissions scheme.
      type: boolean
    explicit_roles:
      description: The list of roles explicitly assigned to this team member, as a
        space separated list of role names. This list does *not* include any
        roles granted implicitly through permissions schemes.
      type: string
```

#### ChannelMember 结构（频道成员）

**源码位置**: `api/v4/source/definitions.yaml:236`

```yaml
ChannelMember:
  type: object
  properties:
    channel_id:
      type: string
    user_id:
      type: string
    roles:
      type: string
    last_viewed_at:
      description: The time in milliseconds the channel was last viewed by the user
      type: integer
      format: int64
    msg_count:
      type: integer
    mention_count:
      type: integer
    notify_props:
      $ref: "#/components/schemas/ChannelNotifyProps"
    last_update_at:
      description: The time in milliseconds the channel member was last updated
      type: integer
      format: int64
```

#### User 结构（用户）

**源码位置**: `api/v4/source/definitions.yaml:68`

```yaml
User:
  type: object
  properties:
    id:
      type: string
    create_at:
      description: The time in milliseconds a user was created
      type: integer
      format: int64
    update_at:
      description: The time in milliseconds a user was last updated
      type: integer
      format: int64
    delete_at:
      description: The time in milliseconds a user was deleted
      type: integer
      format: int64
    roles:
      type: string
    # ... 其他字段省略
```

### 2.2 角色分类体系

根据 API 定义推断，Mattermost 角色按 **作用域** 分为三层：

| 作用域 | 角色名 | 说明 | 源码证据 |
|--------|--------|------|----------|
| **系统级** | `system_user` | 系统普通用户 | `api/v4/source/users.yaml:1164` |
| **系统级** | `system_admin` | 系统管理员 | `api/v4/source/users.yaml:1164` |
| **团队级** | `team_user` | 团队普通成员 | `api/v4/source/teams.yaml:1105` |
| **团队级** | `team_admin` | 团队管理员 | `api/v4/source/teams.yaml:1105` |
| **频道级** | `channel_user` | 频道普通成员 | `api/v4/source/users.yaml:532` |
| **频道级** | `channel_admin` | 频道管理员 | `api/v4/source/channels.yaml:1522` |

### 2.3 角色存储格式

**源码位置**: `api/v4/source/definitions.yaml:751-755` (TeamMember.roles)

角色以 **空格分隔的字符串** 形式存储，例如：
- `team_user` - 普通团队成员
- `team_user team_admin` - 团队管理员（同时拥有普通成员和管理员角色）
- `channel_user channel_admin` - 频道管理员

### 2.4 显式角色 vs 方案派生角色

**源码位置**: `api/v4/source/definitions.yaml:756-771`

TeamMember 结构中包含三个角色相关字段：

| 字段 | 说明 |
|------|------|
| `roles` | 完整角色列表（含方案派生角色） |
| `explicit_roles` | 显式分配的角色（不含方案派生） |
| `scheme_user` | 是否持有方案派生的普通用户角色 |
| `scheme_admin` | 是否持有方案派生的管理员角色 |

**仅文档描述**: 这种分离设计允许权限方案动态修改角色权限，而不影响用户的显式角色分配。

### 2.5 角色 API 端点

**源码位置**: `api/v4/source/roles.yaml`

| 端点 | 方法 | 说明 | 所需权限 |
|------|------|------|----------|
| `/api/v4/roles` | GET | 获取所有角色列表 | `manage_system` |
| `/api/v4/roles/{role_id}` | GET | 获取单个角色 | 仅需活跃会话 |
| `/api/v4/roles/name/{role_name}` | GET | 按名称获取角色 | 仅需活跃会话 |
| `/api/v4/roles/names` | POST | 按名称批量获取角色 | 仅需活跃会话 |
| `/api/v4/roles/{role_id}/patch` | PUT | 部分更新角色 | `sysconsole_write_user_management_permissions` 或 `manage_system` |

**源码位置**: `api/v4/source/roles.yaml:90-143` (PatchRole)

```yaml
"/api/v4/roles/{role_id}/patch":
  put:
    summary: Patch a role
    description: >
      Partially update a role by providing only the fields you want to update.
      ##### Permissions
      Must have `sysconsole_write_user_management_permissions` or `manage_system` permission.
      When updating the role of a system admin, the `manage_system` permission is mandatory.
```

---

## 三、团队级与频道级权限分层

### 3.1 权限分层架构

Mattermost 采用 **三级权限模型**：

```
┌─────────────────────────────────────────────────────────────┐
│                      系统级权限 (System)                      │
│  create_team, manage_system, manage_roles 等                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      团队级权限 (Team)                        │
│  view_team, manage_team, add_user_to_team,                   │
│  remove_user_from_team, manage_team_roles 等                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      频道级权限 (Channel)                     │
│  read_channel, create_public_channel,                        │
│  manage_public_channel_members, delete_public_channel 等     │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 系统级权限清单

| 权限名 | 说明 | 相关端点 |
|--------|------|----------|
| `manage_system` | 系统管理（超级权限） | 多个端点 |
| `create_team` | 创建团队 | `POST /api/v4/teams` |
| `manage_roles` | 管理系统角色 | `PUT /api/v4/users/{user_id}/roles` |
| `manage_system` | 管理所有角色 | `GET /api/v4/roles` |

### 3.3 团队级权限清单

**源码位置**: `api/v4/source/teams.yaml`

| 权限名 | 说明 | 相关端点 | 源码位置 |
|--------|------|----------|----------|
| `view_team` | 查看团队 | `GET /api/v4/teams/{team_id}` | `teams.yaml:109` |
| `manage_team` | 管理团队（更新、删除、恢复） | `PUT/DELETE /api/v4/teams/{team_id}` | `teams.yaml:144` |
| `create_team` | 创建团队 | `POST /api/v4/teams` | `teams.yaml:9` |
| `add_user_to_team` | 添加用户到团队 | `POST /api/v4/teams/{team_id}/members` | `teams.yaml:636` |
| `remove_user_from_team` | 从团队移除用户 | `DELETE /api/v4/teams/{team_id}/members/{user_id}` | `teams.yaml:844` |
| `manage_team_roles` | 管理团队成员角色 | `PUT /api/v4/teams/{team_id}/members/{user_id}/roles` | `teams.yaml:1111` |
| `list_team_channels` | 列出团队频道 | `GET /api/v4/teams/{team_id}/channels` | `teams.yaml:910` |
| `invite_user` | 邀请用户到团队 | `POST /api/v4/teams/{team_id}/invite/email` | `teams.yaml:1314` |
| `invite_guest` | 邀请访客到团队 | `POST /api/v4/teams/{team_id}/invite-guests/email` | `teams.yaml:1360` |

**源码位置**: `api/v4/source/teams.yaml:109` (GetTeam)

```yaml
"/api/v4/teams/{team_id}":
  get:
    summary: Get a team
    description: |
      Get a team on the system.
      ##### Permissions
      Must be authenticated and have the `view_team` permission.
```

### 3.4 频道级权限清单

**源码位置**: `api/v4/source/channels.yaml`

| 权限名 | 说明 | 相关端点 | 源码位置 |
|--------|------|----------|----------|
| `read_channel` | 读取频道 | `GET /api/v4/channels/{channel_id}` | `channels.yaml:483` |
| `create_public_channel` | 创建公开频道 | `POST /api/v4/channels` (type='O') | `channels.yaml:79` |
| `create_private_channel` | 创建私密频道 | `POST /api/v4/channels` (type='P') | `channels.yaml:79` |
| `create_direct_channel` | 创建私聊频道 | `POST /api/v4/channels/direct` | `channels.yaml:142` |
| `create_group_channel` | 创建群聊频道 | `POST /api/v4/channels/group` | `channels.yaml:179` |
| `manage_public_channel_members` | 管理公开频道成员 | `PUT /api/v4/channels/{channel_id}` | `channels.yaml:515` |
| `manage_private_channel_members` | 管理私密频道成员 | `PUT /api/v4/channels/{channel_id}` | `channels.yaml:515` |
| `delete_public_channel` | 删除公开频道 | `DELETE /api/v4/channels/{channel_id}` | `channels.yaml:581` |
| `delete_private_channel` | 删除私密频道 | `DELETE /api/v4/channels/{channel_id}` | `channels.yaml:583` |
| `convert_public_channel_to_private` | 公开转私密 | `PUT /api/v4/channels/{channel_id}/privacy` | `channels.yaml:721` |
| `convert_private_channel_to_public` | 私密转公开 | `PUT /api/v4/channels/{channel_id}/privacy` | `channels.yaml:722` |

**源码位置**: `api/v4/source/channels.yaml:75-79` (CreateChannel)

```yaml
"/api/v4/channels":
  post:
    summary: Create a channel
    description: >
      Create a new channel.
      ##### Permissions
      If creating a public channel, `create_public_channel` permission is required.
      If creating a private channel, `create_private_channel` permission is required.
```

### 3.5 权限方案 (Schemes) 机制

**源码位置**: `api/v4/source/schemes.yaml`

Mattermost 支持通过 **权限方案 (Scheme)** 覆盖默认权限配置，实现团队/频道级的自定义权限策略。

#### Scheme 作用域

**源码位置**: `api/v4/source/schemes.yaml:20-24` (GetSchemes)

```yaml
parameters:
  - name: scope
    in: query
    description: Limit the results returned to the provided scope, either `team` or `channel`.
```

Scheme 分为两种作用域：
- **team**: 团队级权限方案
- **channel**: 频道级权限方案

#### Scheme API 端点

| 端点 | 方法 | 说明 | 所需权限 |
|------|------|------|----------|
| `/api/v4/schemes` | GET | 获取方案列表 | `manage_system` |
| `/api/v4/schemes` | POST | 创建方案 | `manage_system` |
| `/api/v4/schemes/{scheme_id}` | GET | 获取单个方案 | `manage_system` |
| `/api/v4/schemes/{scheme_id}` | DELETE | 删除方案 | `manage_system` |
| `/api/v4/schemes/{scheme_id}/patch` | PUT | 部分更新方案 | `manage_system` |
| `/api/v4/schemes/{scheme_id}/teams` | GET | 获取使用该方案的团队 | `manage_system` |
| `/api/v4/schemes/{scheme_id}/channels` | GET | 获取使用该方案的频道 | `manage_system` |

#### 团队 Scheme 关联

**源码位置**: `api/v4/source/teams.yaml:1544-1595` (UpdateTeamScheme)

```yaml
"/api/v4/teams/{team_id}/scheme":
  put:
    summary: Set a team's scheme
    description: >
      Set a team's scheme, more specifically sets the scheme_id value of a
      team record.
      ##### Permissions
      Must have `manage_system` permission.
    parameters:
      - name: team_id
        in: path
        required: true
        schema:
          type: string
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required:
              - scheme_id
            properties:
              scheme_id:
                type: string
                description: The ID of the scheme.
```

#### Scheme 派生角色更新

**源码位置**: `api/v4/source/teams.yaml:1153-1214` (UpdateTeamMemberSchemeRoles)

```yaml
"/api/v4/teams/{team_id}/members/{user_id}/schemeRoles":
  put:
    summary: Update the scheme-derived roles of a team member.
    description: >
      Update a team member's scheme_admin/scheme_user properties. Typically
      this should either be `scheme_admin=false, scheme_user=true` for
      ordinary team member, or `scheme_admin=true, scheme_user=true` for a
      team admin.
      ##### Permissions
      Must be authenticated and have the `manage_team_roles` permission.
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required:
              - scheme_admin
              - scheme_user
            properties:
              scheme_admin:
                type: boolean
              scheme_user:
                type: boolean
```

**仅文档描述**: Scheme 机制允许管理员创建自定义权限方案，覆盖默认角色的权限。例如，可以创建一个"受限团队用户"方案，使团队用户无法创建公开频道。

---

## 四、成员状态变更后的权限联动

### 4.1 用户激活/停用

**源码位置**: `api/v4/source/users.yaml:1204-1252` (UpdateUserActive)

```yaml
"/api/v4/users/{user_id}/active":
  put:
    summary: Activate or deactivate a user
    description: >
      Activate or deactivate a user's account. A deactivated user can't log
      into Mattermost or use it without being reactivated.
      ##### Permissions
      User can deactivate themselves.
      User with `manage_system` permission can activate or deactivate a user.
    parameters:
      - name: user_id
        in: path
        required: true
        schema:
          type: string
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required:
              - active
            properties:
              active:
                type: boolean
                description: Use `true` to activate the user or `false` to deactivate them
```

#### 用户停用的联动影响

**仅文档描述**: 根据 API 描述和 Mattermost 架构推断：

| 操作 | 权限联动影响 |
|------|--------------|
| 用户停用 (`active=false`) | 1. 所有会话被撤销<br>2. 无法登录系统<br>3. 权限校验时会检查 `delete_at` 字段<br>4. 团队/频道成员身份可能被标记为无效 |
| 用户激活 (`active=true`) | 1. 恢复登录能力<br>2. 团队/频道成员角色恢复生效 |

#### 用户停用的替代端点

**源码位置**: `api/v4/source/users.yaml:1060-1095` (DeleteUser)

```yaml
"/api/v4/users/{user_id}":
  delete:
    summary: Deactivate a user account.
    description: >
      Deactivates the user and revokes all its sessions by archiving its user
      object.
      ##### Permissions
      Must be logged in as the user being deactivated or have the `edit_other_users` permission.
```

### 4.2 系统角色变更

**源码位置**: `api/v4/source/users.yaml:1159-1203` (UpdateUserRoles)

```yaml
"/api/v4/users/{user_id}/roles":
  put:
    summary: Update a user's roles
    description: >
      Update a user's system-level roles. Valid user roles are "system_user",
      "system_admin" or both of them. Overwrites any previously assigned
      system-level roles.
      ##### Permissions
      Must have the `manage_roles` permission.
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required:
              - roles
            properties:
              roles:
                type: string
                description: Space-delimited system roles to assign to the user
```

#### 系统角色变更的联动影响

**仅文档描述**:
- 升级为 `system_admin` → 获得所有管理权限
- 降级为仅 `system_user` → 失去系统管理员权限

### 4.3 团队成员角色变更

**源码位置**: `api/v4/source/teams.yaml:1099-1152` (UpdateTeamMemberRoles)

```yaml
"/api/v4/teams/{team_id}/members/{user_id}/roles":
  put:
    summary: Update a team member roles
    description: >
      Update a team member roles. Valid team roles are "team_user",
      "team_admin" or both of them. Overwrites any previously assigned team
      roles.
      ##### Permissions
      Must be authenticated and have the `manage_team_roles` permission.
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required:
              - roles
            properties:
              roles:
                type: string
                description: Space-delimited team roles to assign to the user
```

#### 团队角色变更联动

**仅文档描述**:

```
团队角色变更 → 影响团队级权限
     │
     ├── 升级为 team_admin
     │       └── 获得 manage_team, manage_team_roles, add_user_to_team,
     │           remove_user_from_team 等权限
     │
     └── 降级为仅 team_user
             └── 失去管理员权限，但保留基础成员权限
```

### 4.4 团队成员添加/移除

#### 添加团队成员

**源码位置**: `api/v4/source/teams.yaml:626-670` (AddTeamMember)

```yaml
"/api/v4/teams/{team_id}/members":
  post:
    summary: Add user to team
    description: >
      Add user to the team by user_id.
      ##### Permissions
      Must be authenticated and team be open to add self.
      For adding another user, authenticated user must have the `add_user_to_team` permission.
```

#### 移除团队成员

**源码位置**: `api/v4/source/teams.yaml:796-873` (RemoveTeamMember)

```yaml
"/api/v4/teams/{team_id}/members/{user_id}":
  delete:
    summary: Remove user from team
    description: >
      Delete the team member object for a user, effectively removing them from
      a team.
      ##### Permissions
      Must be logged in as the user or have the `remove_user_from_team` permission.
```

#### 团队成员移除的频道联动

**仅文档描述**:

```
用户从团队移除 → 级联影响
     │
     ├── 1. TeamMember 记录被删除/标记 (delete_at 设置)
     │
     ├── 2. 团队角色失效 (team_user, team_admin)
     │
     ├── 3. 频道成员身份处理（取决于配置）
     │       ├── 自动从所有团队频道移除
     │       └── 或保留但失去团队级权限继承
     │
     └── 4. 权限缓存失效
             └── 下次权限校验时重新计算
```

### 4.5 频道成员管理

#### 添加频道成员

**源码位置**: `api/v4/source/channels.yaml:1409-1455` (AddChannelMember)

```yaml
"/api/v4/channels/{channel_id}/members":
  post:
    summary: Add user(s) to channel
    description: Add a user(s) to a channel by creating a channel member object(s).
    requestBody:
      content:
        application/json:
          schema:
            type: object
            properties:
              user_id:
                type: string
                description: The ID of user to add into the channel, for backwards compatibility.
              user_ids:
                type: array
                items:
                  type: string
                minItems: 1
                maxItems: 1000
                description: The IDs of users to add into the channel
```

#### 批量设置频道成员（含管理员角色）

**源码位置**: `api/v4/source/channels.yaml:1456-1530` (SetChannelMembers)

```yaml
"/api/v4/channels/{channel_id}/members":
  put:
    summary: Set channel members
    description: >
      Set the complete membership list for a channel, with optional channel admin designation.
      When `channel_admins` is provided, a role reconciliation phase runs after membership
      changes: listed users are promoted to channel admin, all other members are demoted.
      When `channel_admins` is omitted (null), existing admin roles are preserved.
      ##### Permissions
      Must have `manage_system` permission (system admin only).
```

**仅文档描述**: 此端点支持：
1. 批量添加/移除频道成员
2. 批量设置/取消频道管理员角色

---

## 五、请求处理链路中的权限校验位置

### 5.1 API 端点级权限定义

**源码位置**: 各 `api/v4/source/*.yaml` 文件

每个 API 端点的 `description` 字段中包含 `##### Permissions` 小节，定义了该端点所需的权限。

#### 示例：创建团队端点

**源码位置**: `api/v4/source/teams.yaml:1-44`

```yaml
"/api/v4/teams":
  post:
    tags:
      - teams
    summary: Create a team
    description: |
      Create a new team on the system.
      ##### Permissions
      Must be authenticated and have the `create_team` permission.
    operationId: CreateTeam
```

#### 示例：获取团队成员列表

**源码位置**: `api/v4/source/teams.yaml:566-625`

```yaml
"/api/v4/teams/{team_id}/members":
  get:
    summary: Get team members
    description: >
      Get a page team members list based on query string parameters - team id,
      page and per page.
      ##### Permissions
      Must be authenticated and have the `view_team` permission.
```

### 5.2 权限校验点汇总

根据 API 定义，权限校验发生在以下场景：

| 场景 | 校验时机 | 示例权限 | 源码位置 |
|------|----------|----------|----------|
| **团队访问** | 读取团队信息 | `view_team` | `teams.yaml:109` |
| **团队管理** | 更新/删除团队 | `manage_team` | `teams.yaml:144` |
| **成员添加** | 添加用户到团队 | `add_user_to_team` | `teams.yaml:636` |
| **成员移除** | 从团队移除用户 | `remove_user_from_team` | `teams.yaml:844` |
| **角色管理** | 更新团队成员角色 | `manage_team_roles` | `teams.yaml:1111` |
| **频道创建** | 创建公开频道 | `create_public_channel` | `channels.yaml:79` |
| **频道创建** | 创建私密频道 | `create_private_channel` | `channels.yaml:79` |
| **频道读取** | 读取频道信息 | `read_channel` | `channels.yaml:483` |
| **频道管理** | 更新频道信息 | `manage_public_channel_members` | `channels.yaml:515` |
| **频道删除** | 删除公开频道 | `delete_public_channel` | `channels.yaml:581` |
| **系统管理** | 管理所有角色 | `manage_system` | `roles.yaml:9` |

### 5.3 权限校验流程（推断）

**仅文档描述**: 核心实现不在此仓库，根据 API 设计推断：

```
HTTP 请求到达
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  1. 认证层 (Authentication)                                   │
│     - 验证 Session Token / Bearer Token                      │
│     - 获取当前用户信息 (User 对象)                            │
│     - 检查用户是否激活 (delete_at == 0)                       │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  2. 授权层 (Authorization)                                   │
│     - 解析 API 端点所需权限 (从路由定义或注解)                 │
│     - 计算用户有效权限集合:                                    │
│       │                                                       │
│       ├── 系统级角色权限 (system_user, system_admin)          │
│       ├── 团队级角色权限 (team_user, team_admin)              │
│       ├── 频道级角色权限 (channel_user, channel_admin)        │
│       └── 权限方案覆盖 (Scheme 派生角色)                       │
│     - 执行权限检查:                                            │
│       - 检查用户是否有 `manage_system` (超级权限)              │
│       - 或检查用户是否有端点所需的具体权限                      │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  3. 业务层 (Business Logic)                                   │
│     - 可能包含额外的上下文权限检查                              │
│     - 例如: 检查用户是否是特定团队/频道的成员                   │
│     - 例如: 检查资源归属关系                                   │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
  请求处理完成
```

### 5.4 权限错误响应

**源码位置**: `api/v4/source/definitions.yaml:7-30`

所有 API 端点在权限不足时返回统一的错误响应：

```yaml
responses:
  Forbidden:
    description: Do not have appropriate permissions
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/AppError"
  Unauthorized:
    description: No access token provided
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/AppError"
```

**源码位置**: `api/v4/source/definitions.yaml:7-18`

```yaml
Forbidden:
  description: Do not have appropriate permissions
  content:
    application/json:
      schema:
        $ref: "#/components/schemas/AppError"
Unauthorized:
  description: No access token provided
  content:
    application/json:
      schema:
        $ref: "#/components/schemas/AppError"
```

### 5.5 权限校验的特殊情况

#### 登录端点无权限要求

**源码位置**: `api/v4/source/users.yaml:1-45`

```yaml
"/api/v4/users/login":
  post:
    summary: Login to Mattermost server
    description: >
      ##### Permissions
      No permission required
```

#### 用户可自行停用

**源码位置**: `api/v4/source/users.yaml:1216-1219`

```yaml
##### Permissions
User can deactivate themselves.
User with `manage_system` permission can activate or deactivate a user.
```

#### 用户可自行从团队移除

**源码位置**: `api/v4/source/teams.yaml:843-844`

```yaml
##### Permissions
Must be logged in as the user or have the `remove_user_from_team` permission.
```

---

## 六、总结

### 6.1 权限模型核心要点

| 维度 | 核心设计 | 源码证据 |
|------|----------|----------|
| **角色体系** | 三级角色：系统级、团队级、频道级 | `definitions.yaml` 中 TeamMember/ChannelMember/User 的 roles 字段 |
| **角色存储** | 空格分隔的字符串格式 | `definitions.yaml:751` |
| **角色分离** | 显式角色与方案派生角色分离 | `definitions.yaml:756-771` |
| **权限分层** | 三级权限：系统级 → 团队级 → 频道级 | 各 API 端点的 Permissions 定义 |
| **权限方案** | 支持 Scheme 覆盖默认权限配置 | `schemes.yaml` 及 `UpdateTeamScheme` 端点 |
| **权限校验** | API 端点级权限定义，认证+授权两层校验 | 各 YAML 文件中端点的 Permissions 小节 |

### 6.2 仓内缺失内容说明

以下内容**不在当前仓库中**，核心实现位于外部依赖：

| 缺失内容 | 说明 |
|----------|------|
| `model/role.go` | Role 数据结构完整定义、权限常量 |
| `model/permission.go` | Permission 数据结构 |
| `app/permissions.go` | 权限校验核心逻辑 |
| `store/sqlstore/role_store.go` | 角色数据持久化 |
| `app/scheme.go` | 权限方案核心逻辑 |
| 中间件层代码 | HTTP 请求的认证授权中间件实现 |
| 权限缓存机制 | 权限计算缓存逻辑 |

### 6.3 可用源码文件索引

| 文件路径 | 内容概要 |
|----------|----------|
| `api/v4/source/roles.yaml` | 角色 CRUD API：`GetAllRoles`、`GetRole`、`PatchRole` 等 |
| `api/v4/source/schemes.yaml` | 权限方案 API：`GetSchemes`、`CreateScheme`、`UpdateTeamScheme` 关联 |
| `api/v4/source/teams.yaml` | 团队管理：成员角色更新、方案角色更新、成员添加/移除 |
| `api/v4/source/channels.yaml` | 频道管理：成员批量设置、管理员角色变更 |
| `api/v4/source/users.yaml` | 用户管理：激活/停用、系统角色更新、登录/登出 |
| `api/v4/source/definitions.yaml` | 数据模型：`TeamMember`、`ChannelMember`、`User` 等结构 |

---

*报告生成时间: 2026-05-02*
