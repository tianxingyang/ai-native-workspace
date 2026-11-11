# PR #39 与 PR #40 共享代码集成验证（2026-11-11）

本轮只在既有独立组合目录继续验证，不修改正式 checkout、原两候选目录、main、真实凭据、授权期限或安全设置，不部署，不自行推送。另一条研发质量门禁切片的文件不在本次修改范围。

## 输入与保留检查

- main：`4f530eb30c91087aefe2575d00cbe846c6048dd8`，tree `fc79472a30e69d127731b0cac9fe775b6f6ed105`。
- PR #39：head `14ae737e2a56ed74d0d687ec33cba1bc59012fff`，tree `37cc84d9421ec0efd474afd1b3e32702f2fc1a25`，与本机基线 `44b3f53a1002488565128ba06da01b1eaf8b1783` 内容相同。
- PR #40：head `b81cfc3902a575eae18a8fb93001f739c61d3d38`，tree `371f548f02e6ffa416ead8106bf6bf2970be4a1d`，与本机交付 `99a6f4ab76171b8158e1ce9eac808bfd60cadff6` 内容相同。
- 之前的隔离组合 `2c6ab07e7f35cb4c7f3ca2afae29d264e2d68e2f`／tree `237daca53399a1175ac7bd5b58cd34c2092c52af` 仅有旧的 293 项 Node 与 12 项代表性浏览器结果，不能代替本轮完整组合验收。

双方共享四个文件：`src/control/service.ts`、`src/control/state.ts`、`src/private/engine.ts`、`src/private/service.ts`。逐项检查保留 PR #39 的严格 `claimInput`、受控槽位、`presentClaim`、Task／Run／pendingDispatch 持久身份，以及 PR #40 的固定 schema 请求拒绝审计、独立 SQLite、1000 条边界、开发 `readBody` 和私有同身份 late-auth。

PR #39 独有八个变更文件均逐 blob 保留。PR #40 独有七个变更文件中，原组合唯一缺失的是最终审计 evidence 文档，本次已原样补齐并核对 blob；其他六个逐 blob 相同。没有用整文件覆盖共享实现，也没有回退任何一侧的安全边界。

新增 `test/pr39-pr40-integration.test.ts` 联合回归：严格 claim 输入与结果 schema、跨 actor 同一 Task／互补槽位、拒绝记录独立持久化和重启、审计 I/O 失败不创建或重放 Task／Run／dispatch，以及开发和私有分段 claim 的到期／撤销／重映射与并发 actor 分离。没有新增产品源修复或依赖。

## 固定 source 与本轮验证

全部本轮产品测试针对 source commit `ecb7a5901836cf56da1a864947721aaa83fc7eb1`，tree `b46ac3f31c49da21e6b58bc28a006ce09e47514d`。与旧组合 `2c6ab07` 相比，产品 `src` blob 完全未变；只补最终审计证据、新增本集成证据和九项联合回归。之后仅补本证据的实际结果，不把后续 docs-only 提交冒充测试执行版本。

Windows；宿主 Node 24.14.0、npm 11.9.0、TypeScript 5.9.3、Playwright 1.58.2，锁定依赖均沿用既有本机副本。

| 命令／检查 | 本轮结果 |
| --- | --- |
| `npm run build` | TypeScript 与桌面／语言资源检查通过 |
| `npm test` | 302/302，通过，0 失败／取消／跳过，约 57.76 秒 |
| `node --test --test-concurrency=1 dist/test/pr39-pr40-integration.test.js`（含于上行） | 9/9，通过，约 0.43 秒 |
| `PLAYWRIGHT_BROWSERS_PATH` 仅设于本次命令，`node node_modules/@playwright/test/cli.js test` | 完整 Chromium 218/218，通过，约 7.6 分钟 |
| `npm run check:web` | 通过 |
| `npm run check:desktop-resources` | 桌面资源与共享／编译语言注册检查通过 |
| `npm run test:desktop-resources` | 6/6，通过，约 0.33 秒 |
| `node --test eval/vit121/harness.test.mjs` | 10/10，通过，约 0.35 秒 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --jobs 2 --target-dir .local/integration-native-target` | 8/8，通过，0 失败／忽略；全新隔离 target 编译约 2 分 20 秒 |
| 开发／私有 demo，各自 fake 与 pi-mock | 四种均 completed；私有 durableReceipt 为 true、Worker 无入站口、日志无 token |
| 本机既有打包 Node 24.22.2 执行 integration／request-audit／work-claims 三个测试文件 | 39/39，通过，约 6.02 秒；不是该 Node 的完整回归 |
| 冲突标记检查与 `git diff --check` | 通过 |

仅复用本机既有浏览器缓存，没有首轮缺缓存启动失败。Rust 所需本地资源只复制既有 Node 24.22.2 和许可证并刷新本轮编译产物：Node 前后 SHA-256 与既定准备脚本相同，33 个 `dist/src` 文件与五个 launcher 逐一哈希一致。没有运行可能下载的准备脚本，也没有写入原两候选目录。

## 独立只读复审

另一只读验收线程从固定 `ecb7a59`／`b46ac3f3` 全新导出，在独立目录 build、完整 `npm test` **302/302**（约 57.78 秒）与外部自写探针 **26/26**（约 11.59 秒）全部通过，无剩余阻断。

原 16 组请求审计探针内容 hash 不变，新增十项组合探针覆盖 Task／索引／pending／lease 原子失败回滚、审计独立持久化、背压恢复不重放、跨 actor 净化视图／租约拒绝，以及 1008 次 claim-denial 洪泛。它还全树核对 PR #39 单边八文件和 PR #40 单边七文件逐 blob 保留，无其他路径漂移。该复审未独立运行 Chromium 或 Rust，不把本线程的这两项结果算作其独立结果。

## 保留与范围

发布所用的两个基础 tree 分别逐路径比对，提供相对 #39 的 13 个和相对 #40 的 14 个 changed blob（含本轮联合测试和证据），列出前后 Git blob、mode 与变更类型，用于核对最终发布 tree。还在独立临时 index 中分别从两个 base 加这些变更重建，要求所得 tree 精确相同；不改工作 index、refs 或本机根历史。分支推送、第二父提交和 PR base 调整由父协调执行，本线程不自行发布。

旧 PR #40 的审计证据原样恢复为独立切片历史记录，不冒充本轮组合测试。旧的 293 项 Node／12 项浏览器组合结果同样未计入本轮结果。

所有输入与服务均为本机合成、临时 loopback。没有真实模型、联网调研或付费调用；没有安装新软件、运行下载型准备流程或修改全局设置。缓存浏览器与 Node 仅在本地验证命令中使用。Rust 单元测试不等于新安装包或已安装应用验收。未执行真实多机、生产负载、部署或新授权／凭据变更；请求审计仍仅保留最近 1000 条，持续 I/O 故障和进程退出可能丢失待写记录，Task／Run 的未知执行也不自动重放。
