# 权限策略与配置

首个实现增量覆盖现有线程、消息、任务和 Worker 路径。人与 Agent 共用同一授权计算；成员类型不授予或限制产品动作。自动参与策略仍会忽略 Agent 发出的消息，防止自触发循环，这与动作授权分开。

## 配置方式

私有控制端 v2 配置兼容既有直接 `actions` Grant；新增可选 `policy`。不配置 policy 时继续使用直接授权，危险动作仍默认禁用。配置由服务端操作者在配置文件中维护并重启加载；本增量没有在线授权管理 API 或设置界面，也不改动任何真实部署配置。

以下片段合并到现有配置。成员、凭据独立到期时间、具体资源成员关系等仍须显式配置。模板不是自动授予的权限；Grant 必须绑定真实成员和具体线程，模板不存在时配置被拒绝。

```json
{
  "policy": {
    "version": 1,
    "disabledActions": ["grant_permissions", "external_send", "permanent_delete", "continuous_run"],
    "roles": [
      { "id": "read-only", "revision": 1, "actions": ["read"] },
      { "id": "collaborator", "revision": 1, "actions": ["read", "send", "claim", "request_approval", "cancel"] },
      { "id": "resource-admin", "revision": 1, "actions": ["manage_resource"] },
      { "id": "workspace-admin", "revision": 1, "actions": ["manage_workspace"] }
    ]
  },
  "grants": [
    {
      "id": "resource-reader", "memberId": "member1", "revision": 1,
      "conversationId": "team", "threadId": "planning",
      "actions": [], "roleIds": ["read-only", "resource-admin"],
      "effect": "allow", "revoked": false, "expiresAt": 1
    }
  ]
}
```

示例 `expiresAt: 1` 故意已过期，不能直接作为有效授权；使用者须按实际授权填写 Unix 毫秒截止时间。角色名称只是可编辑 ID，不参与特殊判断。管理模板仅表达管理动作，不自动包含读取、发送或扩权。`manage_resource` 已接通目标范围的成员列表与移除接口，见[成员生命周期](membership-lifecycle.md)。[会话创建](conversation-creation.md) 可在显式配置的边界内同时发放初始 Grant，要求 `grant_permissions` 且绑定静态来源；尚无通用在线授权更新、外发、永久删除或持续运行端点。

变更角色时递增 role.revision 和 policy.version；变更 Grant 时递增 grant.revision。整个 policy 还计算摘要：即使误忘递增版本，旧任务也不能继续使用改变后的策略。相同 Grant 可以组合多个模板和直接动作；不同 Grant 也可以分别授予 read、claim、send、request_approval。

## 判断与任务绑定

1. 主体必须是已知 Member，并处于目标线程的有效显式成员范围；持久化移除记录优先于静态配置中的成员关系。
2. 未授予动作就拒绝；成员关系、任务分配或角色名字均不能替代授权。
3. `disabledActions` 先拒绝；移除禁用项本身不会授予动作。
4. 资源、成员、动作匹配且未撤销、未到期的 deny 优先于所有 allow，包括任务已绑定的 allow。deny 到期或撤销后不再生效。
5. allow 必须同时满足资源、成员、动作、到期时间及任务原始 Grant ID/revision，不能偷偷切换到后来新增的替代 Grant。
6. 取消单独要求 read + cancel；send 既非前提，也不能替代 cancel。客户端按钮提示与服务端使用相同计算。

任务编译时绑定四项工具动作的独立 Grant、策略版本/摘要，以及最早到期时间。在运行内读取、确认认领、请求审批、发布、领取和事件对账时，重新检查所有绑定；任一撤权、版本变更或新 deny 都会阻止旧任务继续。迁移到 policy 后，没有策略绑定的旧任务不会被静默升级授权。

Worker 的应用授权不等于 OS 权限或第三方权限。现有工具仍只有四个 CoSeat API 工具、模拟资料与模拟模型；本增量未实现、未验证 OS 文件/网络隔离和第三方凭据边界。不会通过增加字段假称三层隔离已经生效。

## 事件与审计

`input_received` 只代表协议接收。`status: running` 只代表调度开始。`input_applied` 由 provider 明确确认：fake 在处理入口确认；pi 在 SDK 把对应用户输入加入 Agent 状态后确认。它不证明模型完成、结果发布或内容已持久保存。初始化失败不能产生应用确认。取消受理与真正停止仍分别记录；如果 SDK 在取消竞态中确已加入输入，应用事件必须保留。

授权审计保留最近 1000 条判断，含原因、资源 ID、策略版本/摘要、Grant ID/revision；拒绝记录独立于业务事务回滚。策略和 Grant 版本拒绝也记录。配置启动变更另保留最近 1000 个不含 token 的配置快照、时间和前后摘要，来源标记为 `startup_configuration`，不冒充已认证的操作者操作记录。它是 SQLite 试用审计，不是防篡改或无限期合规日志；authentication、全部 HTTP/protocol 拒绝不在本次完整覆盖范围。

## 仍待后续实现

- 在线角色/Grant 管理、冲突控制、变更操作者身份、管理界面。
- 独立可限制/撤销的委托链与向下失效；按能力与范围指定审批者及执行流程。
- Member 生命周期、完整消息编辑/撤回/退群 API、搜索/摘要删除传播。
- 动态 ContextCompiler、已加载上下文清理/重建及撤权推送。
- 真实 OS 和外部服务边界、跨设备隔离验收。

当前撤权会阻止后续 API 动作；Worker 无法继续续租时使用已有 watchdog 协作取消，无法取得停止确认时保留 unknown，不能说已擦除模型内存或已撤销外部动作。策略变化采用保守拒绝旧任务，需要重新创建工作包；不提供透明恢复。
