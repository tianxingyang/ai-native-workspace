# 两端私有试用切片

此版本提供独立私有身份配置、出站 Worker 和 SQLite 持久化，仍只执行显式模拟研究。没有远程部署、真实模型调用、真实网页调研、企业 SSO 或完整 UI。默认授权和项目许可证仍未决定；示例 Grant 需要试用管理员逐项确认，不能当作正式默认值。

## 固定版本与本地验证

开发基线 main：`69d8bfa9bb9b7b35bf475748f988785558d94863`。`.node-version` 固定本轮验证的 Node 24.14.0；运行范围限制为 Node 24.x（>=24.14）。npm 11.9.0 实测。目标设备若用其他 Node 24 补丁版，部署前需在该版本重跑 smoke test。pi SDK 1.4.0、TypeScript 5.9.3 及传递依赖由 lockfile 固定，没有新增第三方数据库依赖。

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --cache .npm-cache
npm test
npm run demo:private
npm run demo:private -- --pi-mock
npm run demo
npm run demo -- --pi-mock
```

`demo:private` 用两个独立进程与临时 SQLite 文件验证私有入口。仅为本机测试生成临时随机认证值，经子进程环境传递，结束后销毁；配置文件仅保存环境变量名称，不打印令牌。它不生成部署凭据。演示验证 Worker 无入站监听、回源结果、退出后回执仍持久存在及日志无测试令牌。

## 两端启动与停止

下面是待执行的操作说明，本轮未对任何远端执行。先在两端准备同一审阅通过的 commit、固定 Node 版本和构建产物。可以在开发设备 `npm ci`、`npm run build`，但不要跨 OS 复制整个 `node_modules`；目标平台需按 lockfile 安装运行依赖（`npm ci --omit=dev --ignore-scripts`）或构建经过目标平台验证的发布目录。无需 Git 常驻运行，也不需要 Docker。

控制端使用 v2 [private-control.example.json](../examples/private-control.example.json)，Worker 保持 v1 [private-worker.example.json](../examples/private-worker.example.json)。配置放在仓库外，分别指定绝对路径。示例的 `tokenExpiresAt: 0` 和 `expiresAt: 0` 故意不可启动；需明确设置毫秒 Unix 时间、成员范围、动作及到期时间。修改授权语义时增加 Grant revision。所有身份必须稳定，不能复用旧成员 ID 表示另一人。

由管理员通过既定秘密管理或受保护的进程环境提供令牌，本版本不生成、保存或分发真实秘密。控制进程接收所配置成员的令牌；Worker 仅接收自己的 `COSEAT_AGENT_TOKEN`。令牌至少 32 个非空白 ASCII 字符，长度检查不替代随机性与访问管理。公开 `dev-fixture`、示例占位值和已知演示固定值拒绝启动；实际 token 值不写入 JSON 配置、命令行或日志。不要启用 shell tracing 或打印环境。

控制端：

```sh
# 令牌已由受保护的进程环境提供；此处只指定不含秘密的配置路径。
COSEAT_CONFIG=/etc/coseat/control.json npm run private:control
```

Worker：

```sh
COSEAT_CONFIG=/etc/coseat-worker/worker.json npm run private:worker
```

控制端固定只绑定 `127.0.0.1`，默认端口 4317。跨设备须由管理员先提供有效 TLS 反向代理或等效受保护链路；Worker 的非回环 `controlUrl` 必须是 HTTPS，拒绝 URL 内嵌凭据、query 和非根路径。无关闭证书校验的选项。不要把回环 HTTP 直接暴露到公网或用明文公网传 bearer token。本文不配置证书、域名、防火墙、安全组、SSH、代理、新用户或持久访问。

Worker 只主动发起 HTTP 请求，没有入站端口或控制面数据库访问。控制端不需要能连接 Worker 私网地址。HTTP 请求最长 5 秒；空闲领取最多等待 750 毫秒，Worker 步间等待 250 毫秒，暂时断线后仅重试幂等领取与事件上报。固定事件日志不输出配置、请求体、令牌或原始异常。

## 凭据与 Grant 的独立期限

每个私有成员当前只有一个静态 bearer 凭据，控制端必须显式配置 `members[].tokenExpiresAt`，表示该凭据的绝对截止时间；不从 Grant 推导，不随轮询、重启或运行续期。它与 provider 的 runtime session、Worker boot instance 不同，也不是完整登录／刷新 token 系统。

- 凭据在 `now >= tokenExpiresAt` 时返回 401 `credential_expired`，所有业务及 Worker 路由都拒绝，包括空闲轮询、事件、未启动确认和取消；无效身份仍为 401 `invalid_identity`。仅无业务内容的 `/health` 不要求认证。
- JSON 请求体读取及长轮询等待之后、执行事务之前重新认证，不能凭进入请求时尚有效而跨过期限操作。
- Grant 的截止只作用于对应成员、资源、动作。一个 Grant 到期不等于成员凭据到期，不阻止其他有效 Grant 覆盖的操作。空闲 Worker 也必须至少有一个仍有效且成员范围匹配的完整执行 Grant 才能轮询，否则 403 `worker_poll_denied`。
- 已有 Run 的轮询、工具及事件绑定原 Grant 的 ID、revision、配置期限及工作包期限；新的同范围 Grant 不能悄悄续期旧 Run。当前事件协议使用同一完整执行 Grant，不额外发放报告权限。
- 没有到期善后豁免：过期／撤销后不能发输出、终态事件、未启动确认或通过过期权限取消。另一个仍获有效 read/cancel Grant 的成员可以按自己的权限取消，并记录正常授权审计；这不延长 Worker 的权限。

若执行端在期限之后才尝试报告停止，控制端会拒绝，不能声称收到停止证据。Worker 失去续租后通过本地 watchdog 尽力停止；控制端租约过期时查询显示 unknown，已有回执仍保留。过期任务的未结租约继续占用单成员执行槽，即便该成员另有有效 Grant 也不能并行重派；其他获权读写仍可使用。此版本没有强制解锁或单独善后权限 API，须在授权到期前留出停止／对账时间。

## 从旧配置升级的约束

**旧控制端 v1 配置会拒绝启动新代码**，缺少期限不能回退为永久凭据。管理员需在审阅后将控制配置改为 v2，并逐个填写已经批准的绝对 `tokenExpiresAt`；如已有试用截止时间，应保留该时间，不能改成“升级后再计一段时间”。Grant 期限也保持原值。Worker 配置版本和 SQLite schema 1 均不变，没有数据库迁移或真实令牌生成。

已过期但格式有效的凭据／Grant 可保留在配置中：服务重启后仍逐项拒绝，而不因一个成员过期阻止其他成员启动；零值、缺失、非整数等非法期限仍拒绝配置。升级前仍须离线备份、安排停止和对账；重启会按既有规则封住未结租约。

源码修复不自动替换任何部署包装器或计时器。切换前应核对新配置保留原授权窗口、拒绝语义（凭据 401、Grant 403）及停止行为，再评估是否撤下旧包装器；本轮未执行这些远程动作。回退到旧源码会重新暴露空闲轮询／事件期限缺口，不能在撤掉独立到期保护后直接回退旧代码。

停止顺序：先停止接收新用户工作，给 Worker 发送 SIGTERM / Ctrl+C，使其请求停止运行并尝试提交终态；随后给控制进程发送 SIGTERM / Ctrl+C，等待退出再处理数据库文件。若进程被强制杀死或网络断开，不能据此声称已获停止回执。生产进程管理、自动启动及服务账户尚未配置。

## 私有协议与租约

| 接口 | 行为 |
| --- | --- |
| `POST /worker/poll {instanceId}` | 服务端按认证成员选择任务；不接受请求体冒充 member 或指定别人的 run；返回 idle/blocked/execute/cancel |
| `POST /worker/events {instanceId, leaseId, events}` | 认证成员、实例、租约、run/session、序号绑定；只追加或确认相同事件，不再次执行工具 |
| `POST /worker/not-started` | 仅原实例、取消中的租约、尚无 session/事件/回执时，记录 Worker 的未启动确认 |
| CoSeat 工具 API | 除原有成员与资源 ACL 外，还要求当前 instance/lease 头；租约失效或取消后拒绝新动作和结果 |

单成员同一时刻最多一个未结租约。首次领取及其租约在响应之前持久化；重复领取返回同一 lease，Worker 在应用输入前记录本进程已见 lease，重复交付不会启动第二次执行。另一个进程实例不能接管仍未结的工作，即使租约过期也只返回 blocked。

租约默认 10 秒，成功轮询续租。服务器使用自己的时钟判定到期，Worker 使用返回的 TTL 启动本地停止 watchdog，避免跨设备时钟差。断线时 Worker 尽力停止本地执行；服务器仍独立按 lease 拒绝迟到结果。取消持久化为命令，重连后持续返回 cancel，直到收到真实终态或该实例的未启动确认。取消收到不等于已经停止。

只读状态查询也检查租约是否过期。未知或过期工作不会重新入队；不会因超时重新运行结果未知的外部动作。本轮只有 CoSeat 工具和合成资料，尚无第三方外部动作集成。发布由 run 唯一回执去重；若回复丢失，可以读取 Run/原线程核对已保存回执，不再次发起研究。

## 持久化与重启

Node 内置 SQLite（本验证版本仍标为实验性）采用 WAL、FULL 同步与排他连接锁，单服务实例使用一个版本化事务快照保存消息、认领、Run、lease、事件、发布回执、审批请求、取消及幂等键。授权配置和 token 不写入快照，启动时重新从明确配置读取。业务事务先落盘再回 HTTP 响应，失败会回滚业务内存和数据库。

`authorize()` 已生成的权限检查记录单独保存在同库 `authorization_audit` 表，独立提交，不随拒绝或业务快照写入失败回滚。只记录 actor、action、allowed、时间以及 conversation/thread ID，不引用消息正文；allowed 表示检查结果，不代表业务已经提交。保留最近 1000 条，重启优先从独立表恢复；旧库尚无该表记录时使用旧快照审计并去除额外资源字段。数据库备份包含两张表，配置仍为 v2、业务快照仍为 schema 1；回退到旧代码会忽略独立表，可能丢失最近的拒绝记录。

审计自身写盘失败时返回 503 `audit_persistence_failed`，不提交业务变更；当前进程保留最近 1000 条待写检查，后续事务须先成功写入审计才能提交业务。磁盘故障期间不能声称审计已持久化，未写入的内存记录在进程退出时仍可能丢失。这是对现有权限检查记录的保留修复，不是新增所有 HTTP、身份失败或协议拒绝的全量审计系统。

这是面向小规模单实例的取舍：快照上限 8 MiB、5000 消息、1000 Run；审计保留最近 1000 条。达到容量会拒绝后续写入，尚无自动归档或清理。每次变更序列化整个快照，适合试用，不是大规模 IM 存储设计；未在实际 2 GiB 设备上做负载测试。第二个控制服务打开同库会失败，不能用多个副本共享 SQLite。

| 重启时事实 | 处理 |
| --- | --- |
| 未领取的 queued Run | 正常重启可继续首次交付 |
| 已领取但未终结 | 封住新动作，标 unknown 或保留 cancel_requested，并向原实例要求 cancel |
| 原 Worker 仍活着 | 用同实例／lease 回传事件，完成终态对账 |
| Worker 已重启、丢失内部 session | 新实例不能重跑旧 Run，保留 unknown/blocked；需要后续显式人工对账能力，本版本不自动解除 |
| 已终结并有回执 | 重启后保留原消息和回执，重复事件不重复发布 |

不承诺跨 harness checkpoint 恢复或外部 exactly-once。普通重启能恢复业务事实，不表示能恢复 SDK 内部执行状态。未知工作会保守阻塞该成员的新工作；本版本没有自动强制接管或人工覆盖终态 API，不建议在此阶段承载必须自动恢复的日常业务。

## 备份、恢复与回退

1. 先停止 Worker 和控制服务，确认数据库不再被写入。不要在运行中只复制 `.sqlite` 而漏掉 WAL。
2. 使用 Node SQLite backup API 生成一个新的、不存在的备份目标：

   ```sh
   npm run private:backup -- /var/lib/coseat/control.sqlite /backup/coseat/snapshot.sqlite
   ```

   此命令只处理数据库，不备份配置或秘密；后者由管理员独立管理。备份包含会话资料，保护要求与原库一致。

3. 恢复前保留当前数据目录，停止旧 Worker。将备份复制到一个新的数据目录并在配置中选择新的数据库路径，保留旧目录用于核对，不原地混合旧 WAL。
4. **从备份恢复必须加 `--restored-backup`**：

   ```sh
   COSEAT_CONFIG=/etc/coseat/restored-control.json npm run private:control -- --restored-backup
   ```

   备份之后发生过什么不能从旧库推断；该模式将所有未终结 Run（包括备份时尚 queued 的工作）封为 unknown，不自动重跑，也不能通过取消把缺失执行历史伪装为未启动。备份时间之后已发生但未记录的副作用仍需人工核对，不能靠恢复消除。

回退代码时先停止两端、备份，再切回已验证 commit。当前 schema 为 1；不认识的版本拒绝启动，无自动破坏性迁移。若需要数据回退，使用上述新目录恢复流程。上一个开发原型只有内存状态，无法承接此 SQLite 数据，也不能当作生产私有服务的回退目标；此切片没有迁移原开发内存会话的入口。

## 实际部署前最小清单

- 审阅并固定本 PR commit，确认模拟模型、试用成员、线程范围、Grant、到期和小数据容量。
- 两端验证 Node/依赖和目标平台启动；控制端准备仅服务账户可读写的数据／配置目录及足够备份空间。
- 管理员提供真实令牌及安全注入方式；Worker 仅有自身成员凭据，不能获得控制端数据库、部署或管理凭据。
- 提供可验证的 HTTPS 入口及 Worker 出站可达性，再做实际跨设备 smoke test；证书和网络规则由管理员单独实施。
- 确认进程启动／停止、离线备份、恢复带 `--restored-backup`、未知状态人工处置和回退方法。

本轮没有执行以上远端操作，真实模型预算、正式角色权限和开源许可证仍未确定。
