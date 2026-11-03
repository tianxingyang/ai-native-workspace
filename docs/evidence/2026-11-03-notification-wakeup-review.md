# PR #4 通知唤醒竞态修复

对应 [P2 review](https://github.com/tianxingyang/ai-native-workspace/pull/4#discussion_r4452357684)，基于 `94016c919560b6ea2af3c22863b01b11bad9b310`，在独立 worktree 验证。此记录只描述本次修复；此前 0.1.1 交付包与其 SHA-256 不代表修复后的应用。

## 原因与修复

原生端取到空通知队列后、IPC 响应抵达 renderer 前，新协议激活会隐藏界面。原处理器仍 busy，直接返回而丢失新唤醒；旧 drain 退出后不再取新通知，可能留下空白窗口。

入口现在先记录 pending wake-up；已在执行时由同一个消费者继续处理。当前 drain 结束或失败后，只有存在新的唤醒才再次 drain。异常仍清空缓存，重复但无数据的唤醒也会恢复当前有效会话或安全错误页。不改变原生通知引用、到期时间、权限检查、队列覆盖规则或连接凭据。

## 回归证据

`browser-test/notifications.spec.mjs` 使用真实本地演示后端，仅模拟原生通知 IPC。通过显式 Promise 暂停已取得的空响应，再注入唤醒，无固定 sleep 安排竞态。原代码稳定失败：预期取通知 5 次，实际仅 3 次，新通知未消费。修复后 7/7 通过。

覆盖处理过通知后的空响应、首次空响应、重复空唤醒、授权到期、401 拒绝、不可用引用及 IPC 异常。检查最后来源、隐藏期间不展示缓存、失效后缓存清空、最多一个消费者、队列消费完成及有界调用次数。

本轮完整检查：

| 检查 | 结果 |
| --- | --- |
| TypeScript、JS syntax、diff whitespace | 通过 |
| 后端，开发 Node 24.14.0 | 49/49 |
| 后端，随包 Node 24.22.2 | 49/49 |
| Chromium 浏览器 | 15/15，含原有 8 项及新增 7 项 |
| Rust release | 3/3 |
| Clippy / fmt | `-D warnings` 与 fmt 通过 |
| NSIS Windows x64 build | 通过；实际安装及卸载退出码均为 0 |
| 安装版 WebView2 冒烟 | 发送、重复提交、停止回执、合成来源、会话/草稿隔离、刷新重连通过；403 scope、外部导航/fetch/新窗口/任意 URL IPC/shell 拒绝，存储为空 |
| 真实通知协议 | 隐藏后恢复到来源、重复激活、断开/未知引用清空缓存通过 |
| 安装版确定性竞态 | 真实协议二次激活发生在空 native IPC 响应交付前；2 次 open、4 次 take，恢复研发讨论，无空白或遗留 loading |
| 清理 | 测试应用/运行时/协议移除，应用及 Node 后台进程 0，临时检查端口 0；其他用户卸载注册项无差异 |

原生竞态复测脚本 `scripts/desktop-notification-race-smoke.mjs` 供同一测试安装实例在现有 `desktop-notification-smoke.mjs` 之后运行。它通过已注册 Windows 协议激活真实通知，在原生 `none` 已返回后暂停交付，再激活第二次。结束后恢复测试钩子；不改变发布应用、权限或操作系统通知设置。

本轮测试包保存在独立 worktree 的 `src-tauri/target/release/bundle/nsis/CoSeat Demo_0.1.1_x64-setup.exe`，25,787,965 字节，SHA-256 `a8fe0efd6607de92efb505becd4f72a08ab4985859d8f62c362b86af92988f1d`。仅用于本轮验证，未覆盖或重新发布此前交付包，未签名。测试安装已卸载。验证日期为 2026-11-03；未修改线上服务、系统通知设置或模型额度。

本次不将协议入口验证称为横幅或通知中心卡片点击验收。既有卡片显示/点击人工验收限制继续保留。
