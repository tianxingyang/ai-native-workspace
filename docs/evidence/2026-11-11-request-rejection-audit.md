# 请求拒绝审计验证（2026-11-11）

VIT-132，VIT-105 子项。只在 VitoYang-PC 的新隔离目录开发与验证，未修改原 checkout、PR #39、真实授权、凭据、安全设置或在线服务，未 push、创建 PR、merge、deploy 或安装软件。依赖从本机现有锁定目录复制，没有真实模型或外网付费调用。

基线 commit `d11182d671d7dd24f62bfee50c4284dda0b3a657` 的 tree 为 `fc79472a30e69d127731b0cac9fe775b6f6ed105`，精确等同当时真实 main `4f530eb30c91087aefe2575d00cbe846c6048dd8`。未把未合并的 PR #39 当作 main。

## 固定产品版本与修复

最终产品源码 commit `1e51ee0f08c717692818e821475d708c9a4e50c1`，tree `5a2bf05d32de061fd16f5e510bf80af7da879ab9`。后续仅补充本证据文档，不把不同产品版本的检查混为一次验证。

- 新增固定七字段请求拒绝账本；开发模式内存、私有模式同库独立 `request_rejection_audit` 表，各保留最近 1000 条，不增加公开审计读取 API。
- 固定 method／route／category，服务器 UUID／时间，身份仅来自认证结果；不持久化 token、hash、header、query、原始 URL／path、动态业务 ID、body、消息、错误文本或 stack。
- 独立于业务回滚和现有 authorization check；审计写失败返回明确 503，后续请求先刷新有界待写记录，不重放业务。记录中的 status 是原始拒绝，不是最终客户端结果或回滚证明。
- 修复已通过 HTTP 解析器但 URL 构造失败会同步退出服务的旧边界；用受控 400／unknown route／协议类别拒绝。
- 开发入口所有读取 JSON 的路由在 await 后重验原身份；私有 body／idle poll 重验同时要求仍为同一 actor。到期、撤销、映射变化均拒绝，不延长期限，不切换身份继续执行。
- 现有授权检查三处正常追加立即截到 1000，避免开发授权拒绝洪泛使旧数组无限增长，不修改权限结果、schema、协议或运行恢复规则。

独立审查在旧基线确认了缺口：private／development 共 16 个真实 HTTP 失败未写入授权审计；开发慢 body 到期后仍能提交消息；private 慢 body 的 token 改映射到无 scope 的有效成员后仍能以旧 actor 提交。初版 `b2e34dc` 的独立审查发现最后一项仍存在后，已经补齐同身份检查；最终验证全部针对 `1e51ee0`。

## 最终回归

Windows，测试宿主 Node 24.14.0，npm 11.9.0，TypeScript 5.9.3。仅合成身份、临时 loopback 服务、真实 SDK＋模拟模型，没有真实模型调用。

| 检查 | 结果 |
| --- | --- |
| `npm test`，含 TypeScript 和桌面／语言资源构建检查 | 280/280，通过，0 失败／取消／跳过，约 54.73 秒 |
| 新增请求审计测试（已包含在上行） | 17/17，通过，约 3.31 秒 |
| 完整 Playwright 浏览器回归 | 218/218，通过，约 7.6 分钟 |
| `npm run check:web` | 通过 |
| `npm run test:desktop-resources` | 6/6，通过 |
| `node --test eval/vit121/harness.test.mjs` | 10/10，通过 |
| 开发／私有 demo，各自 fake 与 pi-mock | 四种均 completed；私有回执持久化、无 Worker 入站口、日志无 token |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`（独立 target 目录） | 8/8，通过，0 失败／忽略，编译约 16.78 秒 |
| 本机既有打包 Node 24.22.2 运行新增审计测试 | 17/17，通过，约 3.24 秒；不是该 Node 的完整回归 |
| `git diff --check` | 通过 |

17 个新增测试含 1008 个开发授权拒绝、1012 次私有 SQLite 记录、1020 次审计故障洪泛、16 个开发分段慢 body 到期／撤销组合，以及私有并发 body、body／idle-poll 重映射、落盘失败恢复、首次拒绝无业务快照、业务回滚、未知路由、恶意异常、已发送响应和真实断线。

## 独立审查

另一只读验收线程在全新导出目录，针对同一 `1e51ee0`／`5a2bf05d` 独立 build、完整 `npm test` **280/280**（约 53.74 秒）与自写外部故障探针 **16/16**（约 4.91 秒）全部通过，无剩余阻断。

探针独立覆盖身份／内容类型／JSON／413／冒用／未知路由，token 和 hash／path／query／body／异常净化，分段输入／并发身份／idle poll，到期／撤销／重映射、授权检查允许但业务快照失败、审计写失败与恢复不重放、1008 次真实 HTTP 洪泛、旧 schema 1、重启、离线备份、恢复投影／腐败拒启，以及已响应／断线／observer 失败生命周期。独立验收未运行浏览器或 PR #39 组合，不把下面的本地组合结果算成其独立结果。

## 未合并 PR #39 的隔离组合

只在第二个新隔离目录把本切片叠到 `44b3f53a1002488565128ba06da01b1eaf8b1783`／tree `37cc84d9421ec0efd474afd1b3e32702f2fc1a25`，该 tree 等同当时 PR #39 head `14ae737`。没有修改或发布 PR #39。

直接 patch 上下文检查在两处 service 文件不适配；三方合并实际在 `src/control/service.ts` 的 import 和 claim route 两个片段需要处理。组合保留 PR #39 的 `claimInput`／`presentClaim` 协议，同时使用本切片 `readBody` 与请求审计。首次组合构建发现遗漏的 import 冲突标记后已修正，未把那次构建记为通过。

最终组合 commit `2c6ab07e7f35cb4c7f3ca2afae29d264e2d68e2f`，tree `237daca53399a1175ac7bd5b58cd34c2092c52af`：完整 `npm test` **293/293**，约 54.35 秒；代表性浏览器 conversations／read-denial／im-presentation **12/12**，约 31.1 秒。该组合不是 main，也不是本切片的发布分支。

## 环境问题与未验证范围

- 首次 Playwright 启动找不到沙箱默认缓存下的 Chromium，未进入产品交互；该运行已停止，不把这些启动失败当作产品测试通过。随后只对验证命令局部指定本机已安装缓存，read-denial 探针 7/7 通过，再运行最终全套。没有安装浏览器或修改全局设置。
- 初次 Rust 测试在本项目资源阶段发现缺少 `.desktop/runtime`，不是 Rust 产品代码失败。一次准备脚本发现 archive 缓存实际缺失并进入下载等待后已取消，确认没有下载 archive／安装新软件；后续只复用本机既有 Node 24.22.2，前后 SHA-256 与固定准备脚本一致，32 个当前 `dist/src` 文件与 5 个 launcher 脚本逐一哈希匹配。最终 8 个 Rust 单元测试通过，但这**不是新安装包或已安装桌面应用的验收**。
- 没有真实多机、生产负载、远程部署、TLS／安全设置或真实期限／凭据变更。没有安装新软件，也没有宣称逐次模型推理回执。
- 审计只覆盖应用可识别、尚能响应的请求拒绝，不覆盖解析器之前的拒绝、已断线请求或全量网络日志。持续磁盘故障、进程退出和超过 1000 条都可能使未写记录丢失；不承诺全量永久保留，也不假称落盘成功。

详细产品边界与故障语义见 [请求拒绝审计](../request-audit.md)。
