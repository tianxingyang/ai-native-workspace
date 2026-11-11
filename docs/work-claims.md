# 规范工作身份与持久认领（VIT-131 / VIT-107 切片）

本切片沿现有合成调研原型补工作身份，不引入新权限模型、真实调研、付费策略或多控制面服务。

## 工作、Task 与 Run

控制端生成 `coseat.work.v1` 工作键，其规范 JSON 元组依次为：规则版本、来源 conversationId、threadId、messageId、message revision、受控 intent `research`、受控 slot。ID 用 JSON 编码，不靠分隔符拼接或正文 hash；成员、自由文本计划、provider session 与 contextRevision 都不决定逻辑工作身份。

唯一性范围是当前控制端／持久库的单 workspace namespace，不是跨库或跨 workspace 的全局键。当前 ControlConfig 与数据库模型没有多 workspace 实体；Worker 的 `workspace` 只是执行目录。

- `research`：综合合成证据，回答来源问题。
- `source_verification`：独立核查合成来源摘录，报告支持、矛盾与证据缺口，不重复主综合。它与主综合互补，并非通过任意后缀绕过去重。

两种槽位沿用原 scope 和动作授权。固定槽位说明进入运行时编译的系统指令，`workIdentity` 绑定进入工作包；Task 账本保留槽位、来源和 owner 供审计。未知意图、任意槽位与客户端提交的 workKey 拒绝，不接受正文授予权限。

Task 有独立 `id`、当前 `workKey`／来源版本、`workKeys` 版本键链、owner、`currentRunId` 与 `runIds`。活动工作的来源正文或上下文变化，仅在原运行已确认结束后换 Run，保留 Task ID 与原 owner；新 revision 显式更新当前键和来源，所有旧键继续映射原 Task，历史来源／授权绑定保留在旧 Run 中，不会被静默吞掉。只有现有失效对账器可推进版本；重试认领本身不启动替代执行。未确认停止时，跨 owner 的新 revision 认领只返回原状态与 `blockedByInvalidation`，不转移 owner 或创建等价执行。

一旦此来源与槽位的任一历史运行已有发布回执，该回执就构成持久副作用屏障。即使正文已编辑成新 revision，也不能借新工作键自动重跑：返回旧 Task 与 `blockedByCompletion: true`。本切片没有显式复跑或补偿协议，revision 本身不是复跑授权。撤回拒绝认领。未知执行保留未知状态，不自动重放外部动作。

## HTTP 与当前权限

开发及私有入口支持 `POST /tools/claim`：

```json
{"sourceMessageId":"source-id","sourceRevision":1,"intent":"research","slot":"research"}
```

`slot` 可省略，默认 `research`；`sourceRevision` 必填且必须等于当前版本。调用者须通过当前身份及 read、claim、send、request_approval 权限检查，之后才返回已有任务。已有工作无论原 owner 是否为调用者，都返回 `{ task, run, duplicate: true, ownedByActor }`，其中 Task 视图含当前状态。被失效版本阻塞时还返回 `blockedByInvalidation` 与 `requestedWorkKey`，不把旧版本假报成新版本。它不转移 owner，不赋予调用者他人 Run 的工具或租约权限。返回的旧运行使用与现有运行读取相同的失效事件清洗，不能通过此接口恢复撤回正文或旧输出。

Worker 的 `claim_task` 继续只调用 `/tools/confirm-claim`，确认其已绑定的 Run，不重新认领或另建任务。参与策略当前仍由配置的 researchMemberId 自动触发；本切片不宣称已完成多成员自主评估和动态分工。

## 持久事务与恢复边界

私有入口在一次 `PrivateEngine.commit` 中同时写入认领索引、唯一逻辑 Task、Run 和 `pendingDispatches` 关系；响应在 SQLite 聚合快照事务成功后才发出。落盘失败会一起回滚。Worker 领取时，租约创建与待派发关系移除也在同一快照事务内。

SQLite 继续使用 WAL、FULL 同步和连接级 EXCLUSIVE 锁。受支持的并发是多个成员／独立 OS 客户端经同一控制面认领。第二控制面连接会因锁被拒绝，不会进入“重启恢复”修改仍活跃的租约。本实现不是进程内 Map 的多写者保证，也不宣称多活控制面、跨设备数据库事务或 exactly-once 外部执行。

未领取的待派发工作重启后保留 Task/Run 身份；已领取工作沿现有规则变成未知／待取消并要求原实例对账，不产生新 Task 或重放。恢复备份仍采用更保守的现有未知状态规则。

旧快照缺少 Task 时按同来源／槽位工作族迁移，保留原 Run/work-package taskId、owner、session、回执与事件。能证明的旧 replacement 链（包括跨来源 revision）合入 root Task，`workKeys` 保留所有版本索引，并以 `legacyTaskIds` 保存历史线上的身份别名。无明确链的旧键碰撞不会挑选执行赢家：保留所有运行事实，Task 标记 `reconciliationRequired` 且 owner 为 null，非终态 Run 封锁为 unknown，不新增派发。本切片不提供自动解冲突或人工复跑接口。

## 本地验收

`test/work-claims.test.ts` 覆盖规范键、24 次跨成员并发、互补槽位的实际编译说明、同文不同消息、SQLite 保存失败回滚、重启、相同 Task 的来源／上下文重建与历史键、旧 revision／撤回拒绝、未确认停机的跨 owner 阻塞、完成后 sibling/source 编辑不复跑、跨 revision 旧链身份与回执、恶劣旧键碰撞，以及独立 OS 客户端竞争和第二控制面真实锁拒绝。现有授权、租约、消息失效、pi admission 和发布丢回执测试继续适用。所有输入、证据、HTTP 与运行时均为本地合成，不调用真实模型或互联网调研。
