# 私有出站切片验证记录（2026-11-02）

基于 main `69d8bfa9bb9b7b35bf475748f988785558d94863`，分支 `codex/private-outbound-slice`。本轮在 Windows 本机用 Node 24.14.0、npm 11.9.0 验证；未连接或改动实际部署设备。所有资料均为合成夹具，认证值仅在本次测试进程内临时生成，没有创建部署凭据。

## 实测结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | TypeScript 构建通过；38/38 通过，0 失败、0 取消、0 跳过；约 12.90 秒 |
| `npm run demo:private` | fake，两个独立进程，completed；退出后 SQLite 中回执存在；捕获日志无测试令牌 |
| `npm run demo:private -- --pi-mock` | 真实 pi SDK 1.4.0＋模拟模型，两个独立进程，completed；持久回执及日志检查通过 |
| `npm run demo` | 原内存 fake 双进程闭环通过 |
| `npm run demo -- --pi-mock` | 原内存真实 SDK＋模拟模型双进程闭环通过 |
| `git diff --check` | 通过 |

私有 fake：control PID `17536`、Worker PID `10300`，Run `a7d6e1ec-8a88-4334-895a-d85aabe5ee75`，回执 `a46b9957-1d88-4c86-9450-83e333ed52a1`。

私有 pi-mock：control PID `26316`、Worker PID `13964`，Run `1c577f5a-3e9f-478e-ba92-fa124e2716d9`，回执 `7e68ecb6-27e7-4e72-86f0-d34b35bf86e7`。

开发入口复验：fake Run `89fef640-a527-4f15-88e3-5d157769ad19`，pi-mock Run `fd617487-2083-4ed3-995a-18becc971c88`，均 completed 并生成原线程回执。

两次私有 demo 均输出 `workerInboundPort: null`、`durableReceipt: true`、`logsContainTokens: false`，结束时关闭子进程并清理临时目录。独立测试还在 Worker 执行期间把 `net.Server.listen` 替换成抛错函数，闭环仍通过。Node 输出 SQLite 实验性 API 警告；这是已知版本限制，未屏蔽。

## 新增 13 项确定性覆盖

- 缺少私有认证、公开夹具身份／令牌、不安全远端 HTTP、URL 内嵌凭据和真实模型 provider 拒绝；错误启动日志不含测试秘密。
- Worker 无入站监听完成回源；控制服务重启后消息、回执和客户端幂等键保留。
- 身份不能由 body 冒充；其他成员不能上报或使用该 lease，领取只返回自己的工作。
- 同一 lease 重复交付和竞争 Worker 实例只执行一次。
- 领取响应在持久化后丢失，Worker 的 session 创建与执行次数均为 0；模拟时钟让租约过期，原实例收到 cancel 并调用 `/worker/not-started`，最终 stopped、无运行事件／发布，重启仍保留未启动证据。
- 事件批次已持久化但确认丢失，Worker 原样重传整个请求；事件数、发布回执不重复，随后续租超过原租约截止仍正常。终态批次确认也注入一次丢失，重传后 completed 并释放租约，重启保留回执。
- 模拟时钟推进使 lease 过期，查询标 unknown、迟到发布拒绝、未知工作不重派。
- 取消在控制服务重启／Worker 断连后仍保留，原实例重连最终收敛 stopped，没有第二次执行。
- running 工作重启后封锁；新 Worker boot 不接管，原实例获得 cancel。
- 重复发布获得同一回执，重复终态事件跨重启不重复生成消息。
- 事务中抛错回滚内存事实；同库第二实例被拒；备份恢复时 queued 变 unknown，取消不能伪造未执行证据。
- 注入“发布事务已完成但 HTTP 回复丢失”：执行和发送各一次，Worker 报失败但原回执保留；重启后不重跑。
- SQLite 离线 backup API 保留相同已提交快照，不覆盖源文件。

原有 25 项回归保留，包括 ACL、来源 revision、并发认领、取消竞态、调度轮询失败后的取消对账及真实 SDK 四轮工具循环。

PR #2 审阅后的两项响应丢失测试均在实际 HTTP 响应成功、SQLite 事务已提交之后，于测试传输层抛出错误，阻止 Worker 消费回复；不使用网络时序猜测或长时间等待。没有发现需要修改运行时代码的问题，本次仅补测试与证据。全套测试和四种 demo 重新运行通过。

## 证据边界

1. **fake adapter**：验证协议和故障语义，不是真实调研。
2. **真实 SDK＋模拟模型**：实际运行 pi session、模型循环、CoSeat HTTP 工具与事件，不只是实例化 SDK；来源仍是固定夹具。
3. **真实模型调用**：未运行，未读取个人模型凭据，未产生模型费用，也未调用第三方外部动作。

同机分进程只证明协议边界，不证明物理隔离。实际 Linux 设备、HTTPS 反向代理、跨网络连接、2 GiB 负载与长时间运行未验证。单实例 SQLite 保存业务事实，但没有 Worker checkpoint 恢复、自动解锁未知工作、在线备份流程、多实例、完整编辑撤权 UI 或一般防循环机制。不能据此把相关产品规划项判为全部验收完成。

迁移／恢复与实际部署前步骤见[两端私有试用](../private-trial.md)，取舍见 [ADR 0002](../adr/0002-private-outbound-sqlite.md)。
