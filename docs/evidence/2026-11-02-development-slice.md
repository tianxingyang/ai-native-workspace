# 开发切片执行记录

日期：2026-11-02。设备：VitoYang-PC / Windows。Node 24.14.0，npm 11.9.0。基线 main：`98f1c7387e09fa4900badd1414d201b4b23d47ee`。仅合成身份、合成来源、loopback HTTP，无真实模型或外部业务调用。

| 命令 | 结果 |
| --- | --- |
| `npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --cache .npm-cache` | 成功；122 packages；固定直接版本及 lockfile |
| `npm test`（包含 TypeScript build） | **18 passed, 0 failed, 0 skipped**；最近一次测试耗时约 4.7 秒 |
| `npm run demo -- --pi-mock` | 成功；control PID 16172，worker PID 9596；Run completed，四轮 SDK 模拟模型循环 |
| `git diff --check` | 通过 |

演示 Run：`e2d6b348-a3f1-4d7a-9069-70fee1a29ab0`。发布回执：`4a57942a-bacc-4cff-9376-c3fdf3cf5500`。事件顺序：`input_received → input_applied → output → status(completed)`。

Alex 连续发送三条群聊消息：午饭闲聊、调研请求、继续讨论界面。只有调研请求创建 Run。Sam 在同一 `runtime-design` 线程发布一条结果，包含两个 `fixtures.invalid` 合成来源及“未访问互联网，不能作为真实调研结论”的限制说明。演示结束后两个服务均已关闭。

测试还单独运行 fake 与 pi-mock 双进程场景；通过 12 并发认领、8 次重复输入、6 次重复结果、未授权读/发、不可见消息不入队、来源/授权版本失效、取消后迟到结果、停止确认和选配能力拒绝等用例。pi 模拟模型用例验证实际三次 HTTP 工具调用的结果进入后续 SDK 轮次，禁止非 loopback fetch，实际工具集合只有四个 CoSeat 工具。

真实模型调用、真实联网调研、物理隔离、持久恢复、完整编辑撤回与防循环、生产身份认证未运行或未实现。以上不构成 VIT-108/112 全部验收完成；更详细范围见[运行说明](../development-slice.md)。
