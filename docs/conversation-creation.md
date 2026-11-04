# 显式创建群聊和私聊

`POST /conversations` 创建持久化的群聊或两人私聊，包含显式初始成员以及可选初始 Grant。已获 read 的成员通过现有 `/session` 发现新会话，并使用原有消息、回复、同步、已读和 Worker 接口。页面显示会话名称，路由仍使用服务器生成的 ID。当前创建操作由 API 发起；尚无创建表单、加人/重新加入、会话改名、邀请链接、新身份或新线程入口。桌面原生桥尚未开放创建路由。

## 显式配置与请求

私有配置 v2 可选 `conversationCreation`；缺省完全禁用创建。配置包含 `authorityScope: {conversationId, threadId}`、`allowedActions` 和正整数 `maxGrantDurationMs`。可委托动作限 `read/send/claim/request_approval/cancel/manage_resource` 的显式子集，不支持 `manage_workspace`、`grant_permissions` 或其他高风险动作。该配置是产品权限规则，不改变机器或网络权限。本实现没有替真实实例启用该规则。

请求示意（ID、期限须由实际授权配置决定）：

```json
{
  "kind": "direct",
  "title": "设计讨论",
  "memberIds": ["member-a", "member-b"],
  "initialGrants": [
    {"targetMemberId": "member-a", "actions": ["read", "send"], "expiresAt": 1893456000000},
    {"targetMemberId": "member-b", "actions": ["read"], "expiresAt": 1893456000000}
  ],
  "clientEventId": "unique-create-request"
}
```

`group` 支持 2–20 个不同成员；`direct` 必须恰好两个。每个初始成员必须是配置中已注册且当前仍属于固定创建授权范围的身份。人和 Agent 适用相同规则。创建者不自动加入，也不会自动获得 read、send 或管理权。成员关系本身不授予内容权限；`initialGrants: []` 创建仅有成员关系、尚不可读的资源。

创建要求认证操作者在服务器固定的授权范围拥有有效 `manage_workspace`，并且来源 Grant 必须是静态配置 Grant。请求不能选择另一个授权来源。非空初始 Grant 还要求同范围 `grant_permissions`；该动作仍默认禁用。管理者可以为他人发放配置明确允许的内容权限，而自己没有 read。显式的 `manage_resource` 只允许目标范围的成员查询/移除，不意味着读取或进一步授权。

每项初始 Grant 必须指定本次成员、动作和绝对截止时间，且期限不得超过两个来源授权的最早到期时间，也不得超过配置的最长时长。授权与资源、初始成员、幂等回执在同一 SQLite 状态事务提交，失败全部回滚，不改写配置、凭据或其他资源的 Grant。单实例试点最多创建 500 个会话，并继续受 8 MiB 状态容量限制。

## 来源失效与重试

动态 Grant 绑定创建者、固定授权范围、静态来源 Grant 的 ID/revision/内容摘要、策略摘要及创建规则摘要。每次鉴权和执行发布都重新验证来源的有效成员关系、deny、撤销、期限和绑定，不递归委托。来源失效立即使依赖权限不可用，正常重启不会丢失这些绑定。以新 ID 或新 revision 重新授权不会替换旧绑定；需要重新显式发放权限，当前尚无此更新入口。

这是实时来源依赖，不是永久撤销日志：操作者若原样恢复同一 ID/revision/内容及策略/规则，旧派生 Grant 可能重新有效。撤销后重新授权应使用新的 revision/ID；不可逆撤销及历史备份恢复对账仍需独立机制。移除成员的持久 tombstone 不会因创建接口或恢复 Grant 而清除，本片不支持重新加入。

同一操作者使用相同 `clientEventId` 和相同请求可恢复原创建回执；不同请求复用标识返回 409。重试仍要求当前创建/发放权限，但不会因已经发出的子 Grant 自身到期而重新创建资源。响应仅包含创建元数据和 `duplicate`，不包含消息、运行、凭据或授权来源内部信息。标题不作为路由 ID，前端使用文本节点呈现。

## 验证与边界

HTTP/SQLite 测试覆盖默认禁用、非授权范围、私聊人数、显式 deny、来源失效/修订与重启、无隐式 read、期限和动作越界、并发幂等、事务回滚、动态 Worker 绑定、跨设备限制及成员移除。浏览器测试覆盖动态发现、名称安全呈现、消息收发、重连和权限失效清缓存。测试只使用一次性身份、配置和本地 mock 服务；不构成真实权限、模型费用或部署授权。
