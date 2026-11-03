# Windows 本地模拟客户端

CoSeat Demo 0.1.1 为 Windows x64 Tauri 2 安装版，使用独立 WebView2 窗口，不是外部浏览器快捷方式。PR #2 的鉴权后端与 PR #3 的 IM 界面及其审计/取消修复已合入 main，本分支已纳入这些更新并以 main 为 base；本分支未合并、未部署。0.1.0 原包保留，原 0.1.1 交付包与后续修复测试包的区别见下文回归记录。

当前安装包仅提供一次启动最长 30 分钟的本地模拟团队。人和 Agent 在同一会话中交流，模拟研究在原讨论返回合成资料，取消受理和实际停止回执分别显示。没有真实网络研究、付费模型、远程登录或生产凭据迁移。

## 使用

1. Windows 10/11 x64，需已有 WebView2 Runtime。本安装器不会自动安装系统组件。
2. 运行 `CoSeat-Demo-0.1.1-windows-x64-setup.exe`（本地构建输出名为 `CoSeat Demo_0.1.1_x64-setup.exe`）。默认安装到当前用户，不要求管理员权限。本测试版未代码签名；如 Windows 或证书警告阻止运行，请停止并核对来源，不绕过警告。
3. 从开始菜单打开 **CoSeat Demo**，点“进入本地演示”。无需 API key 或复制凭据。试发“请调研一下插件协议”。
4. 关闭窗口会隐藏到托盘。托盘左键或“显示 CoSeat”恢复窗口；再次启动也会恢复同一实例。使用界面“退出应用”或托盘“退出并结束本地演示”结束后台并清理本次临时数据。断开连接只隐藏会话，不会重置 30 分钟截止时间。
5. 凭据到期后应重新退出应用，再开始新的本地模拟。它与任何远程试点授权无关，不续期远程授权。
6. 在 Windows“已安装的应用”中卸载 **CoSeat Demo**；先退出客户端。WebView2 自身属于系统组件，不由卸载器删除。

原生消息提示由 Windows 控制，不包含消息正文、凭据或资料内容。0.1.1 使用官方 Windows WinRT 通知与固定 `coseat-demo-notice` 协议入口，取代 0.1.0 插件的短期点击回调。通知保存不透明随机引用；来源仅在当前进程内存中。点击入口先重新检查服务端授权、读取新消息，再恢复窗口和来源会话。断开、失效、未知或重启前的引用显示安全说明，不恢复缓存消息；冷启动也不会自动连接。

托盘显示/退出菜单已实际交互通过，通知历史、系统协议入口、关闭隐藏后定位与冷启动拒绝旧通知已实测。**横幅及通知中心卡片本身的显示/点击仍待人工验收**：本机 Windows 接受记录且状态为 Enabled，但自动化没有观察到可点击卡片，不能把入口验证当成卡片点击通过。可手动查看“设置 → 系统 → 通知 → CoSeat Demo”及“请勿打扰”状态；应用不会代改设置。见 [0.1.1 验收记录](evidence/2026-11-03-windows-client-0.1.1.md)，[0.1.0 历史记录](evidence/2026-11-03-windows-client.md)保留。

## 安全边界

- 界面只加载打包资源；禁止导航到外部页面和创建新窗口。CSP 不允许远程脚本或网络 fetch。Tauri capability 只授予本地主窗口事件监听，不开放 shell、文件系统、HTTP 插件或远程来源。
- 原生请求桥只接受 session、messages、runs 和 cancel 路径。后台第二次校验路由，只请求自己创建的随机回环端口。每个 HTTP 请求仍经过现有服务端凭据/Grant 校验，未开放新的权限授予接口。
- owner token 只在后台内存；Agent 临时 token 通过子进程环境传入。它们不写访问文件、日志、URL、浏览器存储或注册表。临时 SQLite 保存合成消息与运行事实，正常退出清理；异常退出依靠 stdin EOF 结束后台，最终仍受 30 分钟上限约束。
- 不注册自启动、系统服务、全局快捷键或持久登录；应用标识为独立的 `tech.anewell.coseat.demo`。安装器注册一个当前用户的静态通知协议 `coseat-demo-notice`，卸载删除；该协议不是网络监听器，也不携带凭据。严格限定 URI 格式，随机引用本身不授予会话权限。前端无协议注册/打开任意 URL 的权限。
- Node 24.22.2 便携运行时只随本安装包分发，不替换系统或现有部署的 Node。压缩包和 node.exe 固定 SHA-256 校验。Node 及 Rust 第三方许可副本位于安装目录 `runtime/`。项目自身许可证仍待选择。
- `desktop_status` 仅返回连接/窗口状态和接收、通知提交计数，不包含消息、路径、进程 ID 或凭据。提交计数不是 OS 展示/点击回执。

## 构建与检查

已有 Rust/MSVC Windows 构建工具、Node 24.x 和 WebView2 的 Windows x64 机器：

```powershell
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run desktop:build
npm test
npm run test:browser
npm run check:web
cargo test --release --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --release --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

构建首次从官方 Node、crates.io、npm 及 Tauri 官方构建附件下载所需依赖；锁定 Cargo.lock 和 package-lock.json。输出位于 `src-tauri/target/release/bundle/nsis/`，安装资源来自忽略提交的 `.desktop/runtime/`。

`scripts/desktop-smoke.mjs` 可连接测试安装实例临时开启的 `127.0.0.1:9227` WebView2 检查端口；发布程序本身不启用检查端口，devtools 关闭。验收时只对该次应用启动设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9227 --remote-debugging-address=127.0.0.1`，结束后退出进程。不要给常规启动设置该变量。

在仓库 `.desktop/installed` 的测试安装启动并通过上述冒烟后，运行 `node scripts/desktop-notification-smoke.mjs`，验证 Windows 自身通知历史及已注册协议入口。其 PowerShell 辅助脚本只读取 CoSeat 的通知记录，不读取其他应用消息、不修改设置。脚本明确不替代真实横幅/通知中心卡片点击验收。

同一实例可继续运行 `node scripts/desktop-notification-race-smoke.mjs`，验证空 IPC 响应交付期间再次激活通知不会丢失唤醒。PR #4 review 修复与本轮构建证据见[通知竞态回归记录](evidence/2026-11-03-notification-wakeup-review.md)；此前已交付的 0.1.1 包不包含这次修复。

共享页面的浏览器验证不能替代 Windows 托盘和通知的实测。未签名、未验证的系统交互、现有依赖风险均需在交付说明中保留。
