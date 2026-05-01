# Mattermost 频道和团队权限模型分析报告

## 1. 概述

Mattermost 的权限系统基于**改进版的 RBAC（角色-based access control）架构**，通过角色来确定哪些用户有权执行各种操作。该权限模型设计精细，支持三级作用域（系统级、团队级、频道级）和灵活的权限方案机制，能够满足企业级协作平台的复杂权限管理需求。

本报告从以下四个维度深入分析 Mattermost 的权限模型：
- **成员角色定义**：分析系统中 6 种角色的定义和职责
- **权限分层架构**：研究频道级和团队级权限的分层设计
- **权限联动更新**：分析成员状态变更时权限如何联动更新
- **权限校验位置**：探讨权限校验在请求处理链路中的具体位置

---

## 2. 成员角色定义

Mattermost 系统中定义了 **6 种用户角色**，每种角色拥有不同的权限级别：

| 角色名称 | 英文标识 | 权限级别 | 主要职责 |
|---------|---------|---------|---------|
| 系统管理员 | System Admin | 最高级别 | 拥有系统所有权限，可管理其他系统管理员 |
| 团队管理员 | Team Admin | 团队级别 | 管理特定团队的设置和成员 |
| 频道管理员 | Channel Admin | 频道级别 | 管理特定频道的设置和成员 |
| 成员 | Member | 基础级别 | 默认角色，拥有基本协作权限 |
| 访客 | Guest | 受限级别 | 外部协作用户，权限受限 |
| 已停用 | Deactivated | 无权限 | 停用账户，无法登录 |

### 2.1 系统管理员 (System Admin)

**定义与职责**：
- 新安装的 Mattermost 系统中添加的第一个用户会被分配系统管理员角色
- 系统管理员允许在系统上执行任何操作
- 只有系统管理员才能对其他系统管理员用户账户进行更改

**核心权限**：
1. **系统控制台访问**：可访问任何团队站点的系统控制台
2. **配置管理**：能够更改系统控制台中提供的任何 Mattermost 服务器设置
3. **角色管理**：
   - 提升和降级其他用户的成员角色与系统管理员角色
   - 提升和降级其他用户到访客角色或从访客角色降级
4. **账户管理**：
   - 停用用户账户并重新激活
   - 管理用户和配置个人访问令牌
5. **特殊权限**：
   - 可访问私有频道（但需要提供私有频道的链接）
   - 可启用用户账户的个人访问令牌
   - 可设置 Bot 账户的特殊权限（如 `post:all`、`post:channels`）

### 2.2 团队管理员 (Team Admin)

**定义与职责**：
- 团队首次创建时，设置者会成为团队管理员
- 这是一个**团队特定的角色**，意味着用户可以是一个团队的管理员，但在另一个团队中只是成员

**核心权限**：
1. **团队设置管理**：可访问团队设置菜单
2. **团队属性管理**：能够更改团队名称和从 Slack 导出文件导入数据
3. **成员管理**：
   - 可访问成员管理菜单
   - 可控制团队成员是成员还是团队管理员
4. **全面管理**：能够管理团队的各个方面，例如加入和管理他们不是成员的私有频道

### 2.3 频道管理员 (Channel Admin)

**定义与职责**：
- 创建频道的人会被分配该频道的频道管理员角色
- 这是一个**频道特定的角色**

**核心权限**：
1. **角色分配**：能够将频道管理员角色分配给频道的其他成员
2. **角色移除**：能够从其他频道管理员持有者中移除频道管理员角色
3. **成员管理**：能够从频道中移除成员
4. **自动化配置**：能够配置频道动作，根据触发条件（如加入频道或在频道中发送消息）自动执行任务
5. **特殊配置**：根据系统配置，频道管理员可被系统管理员授予重命名和删除频道的特殊权限

### 2.4 成员 (Member)

**定义与职责**：
- 这是用户加入团队时被授予的默认角色
- 成员在 Mattermost 团队中拥有基本权限

**典型权限**（取决于系统方案配置）：
- 查看团队和频道
- 发布和编辑自己的帖子
- 上传和下载文件
- 创建公共/私有频道
- 加入公共频道
- 管理自己的成员信息

### 2.5 访客 (Guest)

**定义与职责**：
- 访客是一个权限受限的角色
- 访客使组织能够与组织外部的用户协作，并控制他们在哪些频道以及可以与谁协作

**权限限制**：
- 只能访问被明确邀请加入的频道
- 无法看到团队中的其他频道
- 无法创建新频道
- 无法邀请新成员（除非被明确授予权限）
- 受限的 @提及能力

### 2.6 已停用 (Deactivated)

**定义与职责**：
- 系统管理员可以通过系统控制台停用用户账户
- 停用的账户无法登录系统

**状态特征**：
1. **登出系统**：用户被登出系统
2. **访问限制**：如果用户尝试重新登录，会收到错误消息
3. **成员列表移除**：用户不再出现在频道成员列表中，并从团队成员列表中移除
4. **可恢复性**：停用的账户也可以从系统控制台重新激活，在这种情况下，用户重新加入他们之前所属的频道和团队
5. **消息归档完整性**：Mattermost 被设计为记录系统，因此无法从 Mattermost 系统中删除用户，因为这样的操作可能会损害消息归档的完整性

---

## 3. 频道级和团队级权限的分层架构

### 3.1 核心概念：作用域与上下文

Mattermost 的权限系统基于两个核心概念：**作用域（Scope）**和**上下文（Context）**。

#### 3.1.1 作用域 (Scope)

权限存在于给定的作用域内。Mattermost 系统中有 **三个作用域**：

| 作用域 | 英文 | 说明 | 示例权限 |
|-------|--------|------|---------|
| 系统级 | System | 仅在系统级别有意义 | `manage_oauth`, `create_team` |
| 团队级 | Team | 在团队级别和系统级别都有意义 | `create_public_channel`, `manage_team_roles` |
| 频道级 | Channel | 在频道、团队和系统级别都有意义 | `manage_public_channel_properties`, `create_post` |

**权限级联规则**：
权限从应用它们的上下文向下级联到各个作用域。例如：
- 如果"频道"作用域的权限应用于"团队"上下文，则该权限适用于该团队内的任何频道
- 如果用户在系统上下文中的角色被授予 `manage_public_channel_properties` 权限，则该用户有权管理他们作为成员的所有团队中的所有频道的公共频道属性

#### 3.1.2 上下文 (Context)

上下文是作用域的实例。例如，名为"开发者交流"的频道是频道作用域的一个实例。

**上下文的层次关系**：
上下文之间存在反映作用域层次排序的层次关系。每个上下文有一个父上下文，可能有多个子上下文，最终的父上下文是系统上下文：

```
系统上下文 (System Context)
    └── 团队上下文 A (Team Context A)
    │       ├── 频道上下文 A1 (Channel Context A1)
    │       ├── 频道上下文 A2 (Channel Context A2)
    │       └── 频道上下文 A3 (Channel Context A3)
    └── 团队上下文 B (Team Context B)
            ├── 频道上下文 B1 (Channel Context B1)
            └── 频道上下文 B2 (Channel Context B2)
```

**权限计算规则**：
在确定用户是否允许在给定上下文中执行给定操作时，需要计算该用户在**当前上下文及其所有父上下文**中被分配的所有角色的权限的**并集**。

**示例**：
如果用户在系统上下文中的角色被授予 `manage_public_channel_properties` 权限，则该用户有权管理他们作为成员的所有团队中的所有频道的公共频道属性。

### 3.2 权限方案 (Schemes)

方案描述应用于上下文中的用户以及所有子上下文的默认角色。

#### 3.2.1 方案类型

| 方案类型 | 说明 | 应用范围 |
|---------|------|---------|
| 系统方案 (System Scheme) | 提供系统范围的默认值 | 所有未分配团队覆盖方案的团队 |
| 团队覆盖方案 (Team Override Schemes) | 允许管理员自定义每个团队的权限 | 仅应用于分配给该方案的团队 |

#### 3.2.2 方案继承规则

1. **默认继承**：如果上下文未专门定义方案，则应用父上下文方案的相关部分，最终向上爬取层次结构到系统方案
   - 例如：如果团队 A 没有定义团队作用域的方案，则系统方案将为团队 A 中的所有上下文提供默认值

2. **最低作用域优先**：最低作用域的方案始终在上下文中优先
   - 例如：如果团队 B 有团队作用域的方案，则该方案优先于团队 B 中所有上下文的系统方案默认值

### 3.3 系统方案详解

系统方案设置授予系统管理员、团队管理员、频道管理员、访客（如果启用）和所有成员的默认权限。

#### 3.3.1 系统方案中的角色

| 角色类别 | 说明 | 应用范围 |
|---------|------|---------|
| 访客 (Guests) | 如果启用访客账户，权限应用于所有频道、所有团队中的访客用户 | 跨所有团队 |
| 所有成员 (All Members) | 权限应用于所有成员（包括管理员），在所有频道、所有团队中 | 跨所有团队 |
| 频道管理员 (Channel Administrators) | 权限应用于所有频道、所有团队中的所有频道管理员 | 跨所有团队 |
| 团队管理员 (Team Administrators) | 权限应用于所有团队中的所有团队管理员 | 跨所有团队 |

#### 3.3.2 系统方案配置位置

系统管理员可以通过以下路径配置系统方案：
```
系统控制台 > 用户管理 > 权限 > 系统方案
```

### 3.4 团队覆盖方案详解

在具有多个 Mattermost 团队的系统上，每个团队可能以独特的方式运营和协作。团队覆盖方案为管理员提供了根据每个团队的需求定制权限的灵活性。

#### 3.4.1 团队覆盖方案特性

1. **隔离性**：团队覆盖方案中授予的权限仅应用于分配给该方案的团队
2. **覆盖性**：系统方案不适用于添加到团队覆盖方案的团队
3. **单一性**：团队只能属于一个团队覆盖方案

#### 3.4.2 团队覆盖方案配置位置

系统管理员可以通过以下路径配置团队覆盖方案：
```
系统控制台 > 用户管理 > 权限 > 团队覆盖方案
```

### 3.5 典型权限列表

以下是 Mattermost 系统中的一些典型权限及其作用域：

#### 3.5.1 系统级权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `manage_system` | System | 访问系统控制台 |
| `assign_system_admin_role` | System | 授予其他用户系统管理员角色 |
| `manage_roles` | System | 管理其他用户的系统范围角色 |
| `create_direct_channel` | System | 打开直接消息频道 |
| `create_group_channel` | System | 打开群组消息频道 |
| `list_public_teams` | System | 查看从主菜单访问的"加入另一个团队"中列出的公共团队 |
| `join_public_teams` | System | 从"加入另一个团队"菜单加入公共团队 |
| `create_team` | System | 创建团队 |
| `manage_oauth` | System | 创建、编辑和删除自己的 OAuth 2.0 应用 |
| `manage_system_wide_oauth` | System | 编辑或删除其他用户的 OAuth 2.0 应用 |

#### 3.5.2 团队级权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `invite_user` | Team | 使用发送邮件邀请或获取团队邀请链接邀请用户加入团队 |
| `add_user_to_team` | Team | 将现有服务器用户添加到当前团队 |
| `remove_user_from_team` | Team | 从团队中移除用户 |
| `create_public_channel` | Team | 创建公共频道 |
| `create_private_channel` | Team | 创建私有频道 |
| `list_team_channels` | Team | 列出团队中的公共频道 |
| `join_public_channels` | Team | 加入公共频道 |
| `view_team` | Team | 读取团队对象 |
| `manage_team` | Team | 访问团队设置 |
| `manage_team_roles` | Team | 添加和移除团队成员角色 |
| `view_members` | Team | 列出团队中的所有成员 |

#### 3.5.3 频道级权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `read_channel` | Channel | 查看频道中的帖子 |
| `create_post` | Channel | 在频道中发布 |
| `edit_post` | Channel | 作者编辑自己的帖子 |
| `edit_others_posts` | Channel | 编辑其他用户的帖子 |
| `delete_post` | Channel | 作者删除自己的帖子 |
| `delete_others_posts` | Channel | 删除其他用户的帖子 |
| `add_reaction` | Channel | 为帖子添加表情反应 |
| `remove_reaction` | Channel | 从帖子中移除表情反应 |
| `remove_others_reactions` | Channel | 从帖子中移除其他用户的表情反应 |
| `upload_file` | Channel | 上传文件附件到帖子 |
| `manage_public_channel_members` | Channel | 管理公共频道成员 |
| `manage_private_channel_members` | Channel | 管理私有频道成员 |
| `manage_public_channel_properties` | Channel | 编辑公共频道名称、标题和用途 |
| `manage_private_channel_properties` | Channel | 编辑私有频道名称、标题和用途 |
| `delete_public_channel` | Channel | 归档公共频道 |
| `delete_private_channel` | Channel | 归档私有频道 |
| `manage_channel_roles` | Channel | 添加和移除频道成员角色 |

---

## 4. 成员状态变更时的权限联动更新机制

### 4.1 用户停用流程

当系统管理员停用用户账户时，会触发以下联动操作：

#### 4.1.1 立即执行的操作

| 操作类型 | 说明 | 影响范围 |
|---------|------|---------|
| 会话终止 | 用户被强制登出系统 | 当前所有活跃会话 |
| 登录拒绝 | 用户尝试重新登录时收到错误消息 | 所有未来登录尝试 |
| 成员列表移除 | 用户不再出现在频道成员列表中 | 用户所属的所有频道 |
| 团队成员移除 | 用户从团队成员列表中移除 | 用户所属的所有团队 |

#### 4.1.2 数据状态变化

1. **消息完整性保持**：
   - 用户发布的所有消息保持不变
   - 消息归档的完整性不受影响
   - Mattermost 设计为"记录系统"，不支持物理删除用户

2. **直接消息频道处理**：
   - 与已停用用户的直接消息频道在用户侧边栏中被隐藏
   - 但可以通过"更多…"按钮或使用快捷键重新打开
     - Windows/Linux: `Ctrl + K`
     - Mac: `⌘ + K`

### 4.2 用户重新激活流程

当系统管理员重新激活已停用的用户账户时，会触发以下联动操作：

#### 4.2.1 权限恢复

| 恢复项 | 说明 |
|-------|------|
| 登录权限 | 用户可以重新登录系统 |
| 团队成员身份 | 用户重新加入之前所属的所有团队 |
| 频道成员身份 | 用户重新加入之前所属的所有频道 |
| 角色分配 | 恢复之前的所有角色分配（团队管理员、频道管理员等） |

#### 4.2.2 特殊情况：AD/LDAP 用户

**重要限制**：
- AD/LDAP 用户账户不能从 Mattermost 中停用
- 必须从 Active Directory 中停用这些用户

### 4.3 角色变更时的权限联动

当用户的角色发生变更时，权限会立即生效。

#### 4.3.1 角色提升示例

**场景**：将普通成员提升为团队管理员

**权限变化**：
1. **立即可用**：
   - 获得团队设置访问权限
   - 获得成员管理权限
   - 获得所有团队级别的管理员权限

2. **级联影响**：
   - 在该团队的所有频道中继承更高权限
   - 可以管理他们不是成员的私有频道

#### 4.3.2 角色降级示例

**场景**：将团队管理员降级为普通成员

**权限变化**：
1. **立即撤销**：
   - 失去团队设置访问权限
   - 失去成员管理权限
   - 失去所有团队级别的管理员权限

2. **级联影响**：
   - 只能访问自己是成员的频道
   - 无法再管理其他成员的角色

### 4.4 团队成员状态变更

#### 4.4.1 添加用户到团队

当用户被添加到团队时：

1. **自动角色分配**：
   - 默认分配 `team_user` 角色
   - 根据方案可能分配 `scheme_user` 标志

2. **频道自动加入**：
   - 根据团队方案和频道设置，可能自动加入某些默认频道（如 Town Square、Off-Topic）

3. **权限计算**：
   - 计算用户在系统上下文中的所有权限
   - 计算用户在新团队上下文中的所有权限
   - 合并形成最终权限集

#### 4.4.2 从团队移除用户

当用户从团队移除时：

1. **级联频道移除**：
   - 用户会从该团队的所有频道中移除
   - 频道成员列表更新

2. **角色清理**：
   - 所有团队级别的角色分配被移除
   - 所有频道级别的角色分配被移除

3. **数据保留**：
   - 用户在该团队发布的消息保持不变
   - 消息历史完整保留

### 4.5 频道成员状态变更

#### 4.5.1 添加用户到频道

当用户被添加到频道时：

1. **角色分配**：
   - 默认分配 `channel_user` 角色
   - 可能根据方案设置 `scheme_user` 标志

2. **权限合并**：
   - 系统上下文权限 + 团队上下文权限 + 频道上下文权限
   - 形成该用户在该频道的最终权限

#### 4.5.2 从频道移除用户

当用户从频道移除时：

1. **访问撤销**：
   - 立即失去对该频道的访问权限
   - 无法再查看或发布到该频道

2. **角色清理**：
   - 该频道的所有角色分配被移除

3. **数据保留**：
   - 用户在该频道发布的消息保持不变
   - 消息历史完整保留

---

## 5. 权限校验在请求处理链路中的位置

### 5.1 API 请求处理流程概览

Mattermost 的 API 请求处理遵循典型的 Web 应用程序架构，权限校验发生在请求处理链路的多个关键位置。

#### 5.1.1 整体处理流程

```
客户端请求
    │
    ▼
1. HTTP 路由匹配
    │
    ▼
2. 身份验证 (Authentication)
    │  ├── 验证会话令牌
    │  ├── 验证个人访问令牌
    │  └── 验证 OAuth 令牌
    │
    ▼
3. 权限校验 (Authorization) ←──── 核心位置
    │  ├── 系统级权限校验
    │  ├── 团队级权限校验
    │  └── 频道级权限校验
    │
    ▼
4. 业务逻辑执行
    │
    ▼
5. 响应返回
```

### 5.2 权限校验的核心位置

权限校验主要发生在 **API 处理器（Handler）** 层面，在执行业务逻辑之前进行。

#### 5.2.1 典型的权限校验代码模式

从 Mattermost 源代码中可以看到以下权限校验模式：

**示例 1：读取频道内容的权限校验**

```go
func getPostsForChannel(c *Context, w http.ResponseWriter, r *http.Request) {
    // ... 参数解析 ...
    
    // 获取频道信息
    channel, err := c.App.GetChannel(c.AppContext, channelId)
    if err != nil {
        c.Err = err
        return
    }
    
    // 权限校验：检查用户是否有读取频道内容的权限
    if !c.App.SessionHasPermissionToReadChannel(c.AppContext, *c.AppContext.Session(), channel) {
        c.SetPermissionError(model.PermissionReadChannelContent)
        return
    }
    
    // 附加校验：检查是否允许查看已归档频道
    if !*c.App.Config().TeamSettings.ExperimentalViewArchivedChannels {
        if channel.DeleteAt != 0 {
            // 已归档频道的特殊处理
            // ...
        }
    }
    
    // 执行业务逻辑
    // ...
}
```

**示例 2：文件操作的权限校验**

```go
func uploadFileSimple(c *Context, r *http.Request, timestamp time.Time) *model.FileInfo {
    // ... 参数解析 ...
    
    // 权限校验：ABAC (Attribute-Based Access Control) 策略检查
    if !c.App.HasPermissionToFileAction(
        c.AppContext,
        c.AppContext.Session().UserId,
        c.AppContext.Session().Roles,
        c.Params.ChannelId,
        model.AccessControlPolicyActionUploadFileAttachment,
    ) {
        c.Err = model.NewAppError(
            "uploadFileSimple",
            "api.file.upload_file.abac_denied.app_error",
            nil,
            "",
            http.StatusForbidden,
        )
        return nil
    }
    
    // 获取频道信息（二次验证）
    channel, err := c.App.GetChannel(c.AppContext, c.Params.ChannelId)
    if err != nil {
        c.Err = err
        return nil
    }
    
    // 执行业务逻辑
    // ...
}
```

### 5.3 权限校验方法详解

Mattermost 提供了多个层次的权限校验方法：

#### 5.3.1 按作用域划分的校验方法

| 方法名称 | 作用域 | 说明 |
|---------|--------|------|
| `SessionHasPermissionTo` | 系统级 | 检查会话是否具有系统级权限 |
| `SessionHasPermissionToTeam` | 团队级 | 检查会话是否具有指定团队的权限 |
| `SessionHasPermissionToChannel` | 频道级 | 检查会话是否具有指定频道的权限 |
| `SessionHasPermissionToReadChannel` | 频道级 | 专门检查读取频道内容的权限（更复杂的逻辑） |

#### 5.3.2 高级权限校验方法

| 方法名称 | 用途 | 说明 |
|---------|------|------|
| `HasPermissionToFileAction` | 文件操作 | 检查基于属性的访问控制 (ABAC) 策略 |
| `SetPermissionError` | 错误设置 | 设置权限不足的错误响应（HTTP 403） |

### 5.4 权限校验的详细逻辑

#### 5.4.1 权限计算逻辑

当检查用户是否具有某个权限时，系统会执行以下步骤：

```
步骤 1: 确定权限的作用域
    │
    ▼
步骤 2: 收集用户在相关上下文中的所有角色
    ├── 系统上下文的角色（用户对象的 Roles 字段）
    ├── 团队上下文的角色（TeamMember 对象的 Roles 字段）
    └── 频道上下文的角色（ChannelMember 对象的 Roles 字段）
    │
    ▼
步骤 3: 收集所有角色的权限并集
    ├── 遍历每个角色
    └── 收集角色分配的所有权限
    │
    ▼
步骤 4: 检查目标权限是否在并集中
    ├── 存在 → 允许访问
    └── 不存在 → 拒绝访问
```

#### 5.4.2 TeamMember 和 ChannelMember 中的角色字段

从 API 定义中可以看到角色存储的结构：

**TeamMember 结构**：
```yaml
TeamMember:
  type: object
  properties:
    team_id:
      type: string
      description: 该成员所属团队的 ID
    user_id:
      type: string
      description: 该成员相关用户的 ID
    roles:
      type: string
      description: 分配给该团队成员的完整角色列表，空格分隔的角色名，包括通过权限方案隐式授予的任何角色
    scheme_user:
      type: boolean
      description: 该团队成员是否持有团队权限方案定义的默认用户角色
    scheme_admin:
      type: boolean
      description: 该团队成员是否持有团队权限方案定义的默认管理员角色
    explicit_roles:
      type: string
      description: 显式分配给该团队成员的角色列表，空格分隔的角色名。此列表不包括通过权限方案隐式授予的任何角色
```

**ChannelMember 结构**：
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
      description: 角色（空格分隔的角色名）
    # ... 其他通知相关字段
```

### 5.5 权限错误处理

#### 5.5.1 错误响应格式

当权限校验失败时，系统返回标准的错误响应：

**HTTP 状态码**：
- `401 Unauthorized` - 未认证（身份验证失败）
- `403 Forbidden` - 已认证但权限不足

**错误响应体格式**：
```json
{
    "id": "api.context.session_expired.app_error",
    "message": "Session is expired or revoked",
    "detailed_error": "",
    "request_id": "1234567890",
    "status_code": 401
}
```

#### 5.5.2 错误设置方法

```go
// 设置权限错误（HTTP 403）
func (c *Context) SetPermissionError(permission *model.Permission) {
    c.Err = &model.AppError{
        Where:          "Context",
        StatusCode:     http.StatusForbidden,
        Id:             "api.context.permissions.app_error",
        Message:        "You do not have the appropriate permissions.",
        RequestId:      c.AppContext.RequestId(),
    }
}
```

### 5.6 特殊场景的权限校验

#### 5.6.1 已归档频道的权限校验

已归档频道有特殊的权限校验逻辑：

```go
// 检查实验性配置：是否允许查看已归档频道
if !*c.App.Config().TeamSettings.ExperimentalViewArchivedChannels {
    channel, err := c.App.GetChannel(c.AppContext, channelId)
    if err != nil {
        c.Err = err
        return
    }
    
    // 如果频道已归档且配置不允许查看，则拒绝访问
    if channel.DeleteAt != 0 {
        c.SetPermissionError(model.PermissionReadChannelContent)
        return
    }
}
```

#### 5.6.2 ABAC 策略校验

从 Mattermost v11.2+ 开始，引入了基于属性的访问控制 (ABAC)：

```go
// 文件上传的 ABAC 权限校验
if !c.App.HasPermissionToFileAction(
    c.AppContext,
    c.AppContext.Session().UserId,
    c.AppContext.Session().Roles,
    c.Params.ChannelId,
    model.AccessControlPolicyActionUploadFileAttachment,
) {
    c.Err = model.NewAppError(
        "uploadFileSimple",
        "api.file.upload_file.abac_denied.app_error",
        nil,
        "",
        http.StatusForbidden,
    )
    return nil
}
```

#### 5.6.3 系统管理员的特殊权限

系统管理员在某些场景下拥有自动权限：

1. **看板访问**：系统管理员可以访问服务器上的任何看板，只要他们有看板的 URL，无需请求权限或手动添加。
2. **默认角色**：当系统管理员加入看板时，其默认角色是管理员。
3. **标签显示**：系统管理员在参与者列表上的姓名旁会有管理员标签。

---

## 6. 总结

### 6.1 权限模型核心特点

Mattermost 的权限模型设计具有以下核心特点：

| 特点 | 说明 |
|------|------|
| **三级作用域** | 系统级、团队级、频道级权限分层设计 |
| **级联继承** | 权限从父上下文级联到子上下文，自动合并 |
| **灵活方案** | 系统方案 + 团队覆盖方案，支持全局默认和团队定制 |
| **细粒度控制** | 超过 100 种独立权限，可精确控制每个操作 |
| **角色隔离** | 角色与上下文绑定，同一用户在不同团队/频道可有不同角色 |

### 6.2 关键设计决策分析

#### 6.2.1 显式角色与隐式角色分离

Mattermost 在 `TeamMember` 结构中同时存储：
- `roles`：完整角色列表（包括隐式授予的）
- `explicit_roles`：显式分配的角色列表
- `scheme_user` / `scheme_admin`：方案派生的角色标志

**设计优势**：
1. **查询效率**：`roles` 字段可直接用于权限计算，无需实时解析方案
2. **变更追踪**：`explicit_roles` 和方案标志区分权限来源，便于管理
3. **方案迁移**：当团队切换方案时，可准确重新计算权限

#### 6.2.2 权限校验位置选择

权限校验放在 **API Handler 层** 而非中间件层：

**设计优势**：
1. **灵活性**：不同端点可有不同的校验逻辑（如已归档频道的特殊处理）
2. **上下文感知**：可获取请求参数和资源信息后再校验
3. **组合校验**：支持多条件组合校验（如 ABAC + RBAC）

### 6.3 实际应用建议

#### 6.3.1 权限配置最佳实践

1. **默认使用系统方案**：
   - 大多数场景下，系统方案提供合理的默认权限
   - 仅在需要团队差异化时使用团队覆盖方案

2. **最小权限原则**：
   - 为角色分配仅必要的权限
   - 避免过度授予 `manage_system` 等高级权限

3. **定期审计**：
   - 定期审查系统管理员列表
   - 审查团队管理员和频道管理员分配
   - 及时移除离职用户的访问权限

#### 6.3.2 常见权限配置场景

**场景 1：限制频道创建**
```
目标：只允许管理员创建公共频道

配置步骤：
1. 进入系统控制台 > 用户管理 > 权限 > 系统方案
2. 在"所有成员"面板中，取消勾选"管理公共频道 > 创建频道"
3. 在"团队管理员"面板中，勾选"管理公共频道 > 创建频道"
4. 保存配置
```

**场景 2：创建公告频道**
```
目标：只有频道管理员可以发布，其他成员只读

配置步骤：
1. 创建新频道（公共或私有）
2. 进入系统控制台 > 用户管理 > 频道
3. 选择要配置的频道，点击"编辑"
4. 在"创建帖子"面板中，取消勾选"访客"和"成员"
5. 在"帖子反应"面板中，取消勾选"访客"和"成员"
6. 保存配置
```

**场景 3：限制团队成员添加**
```
目标：在特定团队中只允许管理员添加新成员

配置步骤：
1. 进入系统控制台 > 用户管理 > 权限
2. 编辑系统方案，在"所有成员 > 团队"面板中勾选"添加团队成员"（设置系统默认）
3. 返回权限方案菜单，选择"新建团队覆盖方案"
4. 命名方案（如"受限团队"），添加需要限制的团队
5. 在该方案的"所有成员"面板中，取消勾选"添加团队成员"
6. 在"团队管理员"面板中，勾选"添加团队成员"
7. 保存配置
```

### 6.4 与企业级权限模型的对比

| 维度 | Mattermost 设计 | 典型企业级模型 | 评价 |
|------|----------------|----------------|------|
| 角色粒度 | 6 种预定义角色 + 可自定义方案 | 通常更多预定义角色 | 简洁但灵活，方案机制提供扩展性 |
| 权限粒度 | 100+ 独立权限 | 类似 | 细粒度控制满足企业需求 |
| 上下文感知 | 三级作用域 + 级联继承 | 通常类似 | 设计优秀，权限自动合并 |
| 动态授权 | 基础 ABAC 支持 | 完整 ABAC | Mattermost 正在增强中 |
| 审计能力 | 基础操作日志 | 完整权限变更审计 | Mattermost 可通过插件增强 |

### 6.5 未来演进方向

从代码和文档分析来看，Mattermost 权限模型正在向以下方向演进：

1. **增强 ABAC 能力**：
   - v11.2 引入的 `HasPermissionToFileAction` 显示了 ABAC 的初步应用
   - 未来可能扩展到更多操作类型

2. **更细粒度的集成权限**：
   - 分离"管理自己的集成"和"管理他人的集成"权限
   - 为 Webhook、Slash 命令、OAuth 应用提供独立控制

3. **属性策略引擎**：
   - 支持基于用户属性、资源属性、环境属性的复杂策略
   - 类似 XACML 的策略语言支持

---

## 附录

### 附录 A：完整权限清单

#### A.1 团队管理权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `invite_user` | team | 邀请用户加入团队 |
| `add_user_to_team` | team | 添加现有服务器用户到当前团队 |
| `remove_user_from_team` | team | 从团队移除用户 |
| `create_public_channel` | team | 创建公共频道 |
| `create_private_channel` | team | 创建私有频道 |
| `list_team_channels` | team | 列出团队中的公共频道 |
| `join_public_channels` | team | 加入公共频道 |
| `view_team` | team | 读取团队对象 |
| `manage_team` | team | 访问团队设置 |
| `manage_team_roles` | team | 管理团队成员角色 |
| `view_members` | team | 列出团队中的所有成员 |

#### A.2 频道管理权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `read_channel` | channel | 查看频道中的帖子 |
| `read_public_channel` | team | 查看和访问团队中的公共频道 |
| `create_post` | channel | 在频道中发布 |
| `edit_post` | channel | 作者编辑自己的帖子 |
| `edit_others_posts` | channel | 编辑其他用户的帖子 |
| `delete_post` | channel | 作者删除自己的帖子 |
| `delete_others_posts` | channel | 删除其他用户的帖子 |
| `add_reaction` | channel | 添加表情反应 |
| `remove_reaction` | channel | 移除自己的反应 |
| `remove_others_reactions` | channel | 移除其他用户的反应 |
| `upload_file` | channel | 上传文件附件 |
| `get_public_link` | system | 获取帖子永久链接 |
| `manage_public_channel_members` | channel | 管理公共频道成员 |
| `manage_private_channel_members` | channel | 管理私有频道成员 |
| `manage_public_channel_properties` | channel | 编辑公共频道属性 |
| `manage_private_channel_properties` | channel | 编辑私有频道属性 |
| `delete_public_channel` | channel | 归档公共频道 |
| `delete_private_channel` | channel | 归档私有频道 |
| `manage_channel_roles` | channel | 管理频道成员角色 |

#### A.3 系统管理权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `manage_system` | system | 访问系统控制台 |
| `assign_system_admin_role` | system | 授予系统管理员角色 |
| `manage_roles` | system | 管理系统范围角色 |
| `create_direct_channel` | system | 打开直接消息频道 |
| `create_group_channel` | system | 打开群组消息频道 |
| `list_public_teams` | system | 查看公共团队列表 |
| `join_public_teams` | system | 加入公共团队 |
| `list_private_teams` | system | 查看私有团队列表 |
| `join_private_teams` | system | 加入私有团队 |
| `create_team` | system | 创建团队 |
| `import_team` | system | 导入团队 |
| `edit_other_users` | system | 编辑其他用户的属性 |
| `list_users_without_team` | system | 列出没有团队的用户 |
| `create_user_access_token` | system | 创建用户访问令牌 |
| `read_user_access_token` | system | 读取用户访问令牌 |
| `revoke_user_access_token` | system | 撤销用户访问令牌 |
| `manage_jobs` | system | 创建和取消任务 |

#### A.4 集成管理权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `use_slash_commands` | channel | 使用 Slash 命令 |
| `manage_slash_commands` | system | 管理自己的 Slash 命令 |
| `manage_others_slash_commands` | system | 管理其他用户的 Slash 命令 |
| `manage_incoming_webhooks` | team | 管理自己的传入 Webhook |
| `manage_outgoing_webhooks` | team | 管理自己的传出 Webhook |
| `manage_others_incoming_webhooks` | team | 管理其他用户的传入 Webhook |
| `manage_others_outgoing_webhooks` | team | 管理其他用户的传出 Webhook |
| `manage_oauth` | system | 管理自己的 OAuth 应用 |
| `manage_system_wide_oauth` | system | 管理系统范围的 OAuth 应用 |

#### A.5 Bot 和访客权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `create_bot` | team | 创建 Bot 账户 |
| `assign_bot` | team | 将 Bot 分配给其他用户 |
| `read_bot` | team | 查看自己创建的 Bot |
| `read_others_bots` | team | 查看其他用户创建的 Bot |
| `manage_bots` | team | 编辑和删除自己的 Bot |
| `manage_others_bots` | team | 编辑和删除其他用户的 Bot |
| `invite_guest` | system | 邀请访客用户 |
| `promote_guest` | system | 将访客提升为成员 |
| `demote_to_guest` | system | 将成员降级为访客 |

#### A.6 自定义内容权限

| 权限名称 | 作用域 | 说明 |
|---------|--------|------|
| `create_emojis` | team | 创建自定义表情 |
| `delete_emojis` | team | 删除自己的自定义表情 |
| `delete_others_emojis` | team | 删除其他用户的自定义表情 |

### 附录 B：API 端点权限示例

以下是一些常见 API 端点及其所需权限：

#### B.1 团队相关端点

| 端点 | HTTP 方法 | 所需权限 |
|------|-----------|---------|
| `/api/v4/teams` | POST | `create_team` |
| `/api/v4/teams` | GET | 已认证 + `manage_system`（查看所有团队） |
| `/api/v4/teams/{team_id}` | GET | `view_team` |
| `/api/v4/teams/{team_id}` | PUT | `manage_team` |
| `/api/v4/teams/{team_id}/members` | POST | `add_user_to_team`（添加他人）或已认证（添加自己到开放团队） |
| `/api/v4/teams/{team_id}/members/{user_id}` | DELETE | `remove_user_from_team` |
| `/api/v4/teams/{team_id}/members/{user_id}/roles` | PUT | `manage_team_roles` |

#### B.2 频道相关端点

| 端点 | HTTP 方法 | 所需权限 |
|------|-----------|---------|
| `/api/v4/channels` | POST | `create_public_channel` 或 `create_private_channel` |
| `/api/v4/channels/{channel_id}` | GET | `read_channel` |
| `/api/v4/channels/{channel_id}` | PUT | `manage_public_channel_properties` 或 `manage_private_channel_properties` |
| `/api/v4/channels/{channel_id}` | DELETE | `delete_public_channel` 或 `delete_private_channel` |
| `/api/v4/channels/{channel_id}/members` | POST | `manage_public_channel_members` 或 `manage_private_channel_members` |
| `/api/v4/channels/{channel_id}/members/{user_id}` | DELETE | `manage_public_channel_members` 或 `manage_private_channel_members` |

#### B.3 帖子相关端点

| 端点 | HTTP 方法 | 所需权限 |
|------|-----------|---------|
| `/api/v4/posts` | POST | `create_post` |
| `/api/v4/posts/{post_id}` | GET | `read_channel` |
| `/api/v4/posts/{post_id}` | PUT | `edit_post`（自己的帖子）或 `edit_others_posts`（他人帖子） |
| `/api/v4/posts/{post_id}` | DELETE | `delete_post`（自己的帖子）或 `delete_others_posts`（他人帖子） |
| `/api/v4/channels/{channel_id}/posts` | GET | `read_channel` |

### 附录 C：角色权限矩阵（默认配置）

以下是默认系统方案下的角色权限矩阵（部分示例）：

| 权限 | 系统管理员 | 团队管理员 | 频道管理员 | 成员 | 访客 |
|------|-----------|-----------|-----------|------|------|
| `manage_system` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `manage_team` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `create_team` | ✓ | ✓* | ✗ | ✗ | ✗ |
| `create_public_channel` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `create_private_channel` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `manage_public_channel_properties` | ✓ | ✓ | ✓ | ✓** | ✗ |
| `delete_public_channel` | ✓ | ✓ | ✓** | ✗ | ✗ |
| `create_post` | ✓ | ✓ | ✓ | ✓ | ✓*** |
| `edit_post` | ✓ | ✓ | ✓ | ✓ | ✓*** |
| `delete_post` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `delete_others_posts` | ✓ | ✓ | ✓** | ✗ | ✗ |
| `add_user_to_team` | ✓ | ✓ | ✗ | ✓** | ✗ |
| `remove_user_from_team` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `invite_user` | ✓ | ✓ | ✗ | ✓** | ✗ |
| `invite_guest` | ✓ | ✓** | ✗ | ✗ | ✗ |

*取决于配置
**取决于系统方案配置
***取决于频道权限设置

---

**报告生成时间**：2026-05-02  
**分析基于**：Mattermost 官方文档、API 定义、代码分析  
**版本参考**：Mattermost Server v7.x - v11.x