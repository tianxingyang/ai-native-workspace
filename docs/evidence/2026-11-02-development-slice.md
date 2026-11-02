# 开发切片执行记录

日期：2026-11-02。设备：VitoYang-PC / Windows。Node 24.14.0，npm 11.9.0。基线 main：`98f1c7387e09fa4900badd1414d201b4b23d47ee`。仅合成身份、合成来源、loopback HTTP，无真实模型或外部业务调用。

| 命令 | 结果 |
| --- | --- |
| `npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --cache .npm-cache` | 成功；122 packages；固定直接版本及 lockfile |
| `npm test`（包含 TypeScript build，取消恢复修复后） | **25 passed, 0 failed, 0 skipped** |
| `npm run demo -- --pi-mock` | 成功；control PID 16172，worker PID 9596；Run completed，四轮 SDK 模拟模型循环 |
| `git diff --check` | 通过 |

演示 Run：`e2d6b348-a3f1-4d7a-9069-70fee1a29ab0`。发布回执：`4a57942a-bacc-4cff-9376-c3fdf3cf5500`。事件顺序：`input_received → input_applied → output → status(completed)`。

Alex 连续发送三条群聊消息：午饭闲聊、调研请求、继续讨论界面。只有调研请求创建 Run。Sam 在同一 `runtime-design` 线程发布一条结果，包含两个 `fixtures.invalid` 合成来源及“未访问互联网，不能作为真实调研结论”的限制说明。演示结束后两个服务均已关闭。

测试还单独运行 fake 与 pi-mock 双进程场景；通过 12 并发认领、8 次重复输入、6 次重复结果、未授权读/发、不可见消息不入队、来源/授权版本失效、取消后迟到结果、停止确认和选配能力拒绝等用例。pi 模拟模型用例验证实际三次 HTTP 工具调用的结果进入后续 SDK 轮次，禁止非 loopback fetch，实际工具集合只有四个 CoSeat 工具。

真实模型调用、真实联网调研、物理隔离、持久恢复、完整编辑撤回与防循环、生产身份认证未运行或未实现。以上不构成 VIT-108/112 全部验收完成；更详细范围见[运行说明](../development-slice.md)。

## 独立审查回归

在原实现上先运行三个确定性用例，全部失败：完成事件未消费时取消返回 `cancel_requested`；capabilities 等待期间取消也返回 `cancel_requested`；来源修改后旧 Run 的认领工具导致 Run 数量从 1 增至 2。确认发现成立后才修改实现。

修复后新增的四个回归用例全部通过：完成事件对账并报告取消太晚；创建会话前取消确认未启动且不产生 runtime 事件；创建请求已在途时保留待确认状态，直到 provider 确认未应用输入；旧 Run 在来源版本改变后调用确认认领，返回 `source_revision_changed`，Run 数量仍为 1、派发执行次数为 0。

同时重跑 `npm run demo` 和 `npm run demo -- --pi-mock`，两种双进程演示均完成并关闭服务。真实模型调用仍未运行。

修复后的 fake 演示 PID：23252 / 25968，Run `a1a26ebd-b686-4b94-9784-56b950ac2082`；pi-mock 演示 PID：29168 / 31092，Run `00f48104-0275-4cfe-99c9-f75a0394f1ff`。最后一次完整测试 22/22 通过，耗时约 5.1 秒。

## 取消恢复审查回归

在 `357d280` 原实现上新增确定性用例：首次事件轮询临时失败，使控制端进入 unknown 并退出派发；随后只取消一次，Worker 延迟停止。Worker 确实停止后控制端仍不收敛，测试以 `condition_not_reached` 失败，验证发现成立。

修复采用共享轮询任务、共享在途读取和取消 RPC 去重，并增加有界只读对账。新增三个用例通过：上述失败路径无需第二次取消即可收敛；六个并发取消只发出一次取消 RPC，最大并行事件读取数为 1；持续读取失败后有界退出为 unknown，不产生停止证据且不继续后台轮询。原有 22 项测试仍通过。

完整 `npm test`：25/25 通过，0 失败、0 跳过，约 5.46 秒。`npm run demo`：PID 34924 / 7660，Run `549fd103-1c17-4996-b843-1ba9b632ea69` completed。`npm run demo -- --pi-mock`：PID 7704 / 36708，Run `4a09edb1-5e0b-4a02-8bd3-b7e1735cbce7` completed。两种演示均关闭服务，未运行真实模型、未部署。

剩余限制：对账窗口耗尽或服务重启后仍可能保留 unknown，需要后续显式核对；不重放不确定的取消 RPC。本次没有扩展为持久恢复系统。
