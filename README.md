# CoSeat（同席）

**Team chat for humans and agents.**

CoSeat 是一个以即时通讯（IM）为核心的人与 Agent 协作产品设计：人在私聊和群聊中自然讨论，Agent 作为团队成员，在职责与授权范围内判断是否参与、认领工作、邀请协作，并把进展与成果带回原会话。

> 当前状态：设计与受限开发原型。已提供双进程闭环：合成群消息 → 参与判断 → 后台执行 → 带合成来源回原线程；另有私有配置、出站 Worker 与 SQLite 的试用入口。本分支增加 Windows Tauri 本地模拟安装版，复用 IM 界面和服务端授权；真实联网调研及生产部署尚未实现。安装与验证范围见 [Windows 客户端](docs/client-windows.md)，未通过的桌面交互不会记为完成。

## 产品原则

- **先是通讯工具。** 会话、群聊、线程和成员是入口；任务与执行记录在后台形成，不要求先填工单。
- **同席，不同权限。** 人与 Agent 使用统一成员模型；能力、职责、工作模式与授权分别建模。
- **自主，但不越权。** Agent 不必等到被 @ 才能参与；相关性判断不等于执行授权，缺权限时找有权成员批准或代执行。
- **协作，不强制总指挥。** 成员可以直接协作，不要求所有工作经过一个中央协调 Agent。
- **轻量、可替换的执行基座。** 自有控制面管理消息、授权、任务与记忆边界，Agent runtime 只执行有边界的工作包。
- **有来源的上下文。** 原始记录与派生记忆分开，个人、会话、项目与任务资料按权限隔离。

## 已确定的首版方向（2026-11-02）

- 首个闭环选择 **A：群聊中自主发现调研任务 → 后台研究 → 带来源的结论回到原线程**，不以写代码或发布部署作为首个业务闭环。
- 确定开源方向，具体项目许可证仍待选择。
- CoSeat 服务端与 Agent 执行设备分开部署；应用成员权限与执行设备的操作系统权限分开管理。
- 借鉴 dsh 的插件化理念，以薄的运行时插件/适配器接入 harness，不因此绑定 dsh。开发切片暂用 pi SDK 1.4.0，并保留 Deep Agents 候选；长期选型未定，见 [ADR](docs/adr/0001-runtime-development-slice.md)。
- 先做最小协议、一个运行时插件和一组 CoSeat 工具，再用第二个插件验证抽象。不建设插件市场或通用工作流引擎。

## 文档

- [设计摘要](docs/design.md)：成员模型、消息到工作、授权、运行时与记忆边界。
- [阶段规划](docs/roadmap.md)：实施顺序、验证门槛和待决事项。
- [本地开发切片](docs/development-slice.md)：运行、API、协议边界与验证层级。
- [临时运行时选择 ADR](docs/adr/0001-runtime-development-slice.md)：固定版本、隐式行为和未验证项。
- [两端私有试用](docs/private-trial.md)：显式身份配置、出站领取、启动停止、备份恢复及部署前事项。
- [私有协议与持久化 ADR](docs/adr/0002-private-outbound-sqlite.md)：单实例 SQLite 和未知执行的保守对账。
- [权限策略与配置](docs/authorization.md)：角色模板、显式拒绝、任务授权绑定及当前实现边界。
- [消息编辑与撤回](docs/message-changes.md)：版本冲突、旧运行失效、停止确认与新 session 的边界。
- [可复用 IM 界面与本地演示](docs/client-im.md)：运行、凭据边界、浏览器验收与桌面客户端未决项。
- [Windows 本地模拟客户端](docs/client-windows.md)：安装、退出、构建、权限和当前验收限制。

## 运行原型

固定验证版本为 Node.js 24.14.0，支持范围为 Node 24.x（>=24.14）。所有演示只使用合成身份和资料，不需要模型 API key。

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --cache .npm-cache
npm test
npm run demo
npm run demo -- --pi-mock
npm run demo:private
npm run demo:private -- --pi-mock
npm run demo:im
```

`demo` 使用原内存开发入口；`demo:private` 使用临时私有配置、出站 Worker 与 SQLite，并验证退出后的发布回执。它们自动启动两个本机独立进程并在结束后关闭。`fake` 验证协议；`pi-mock` 通过真实 pi SDK 执行模拟模型的四轮工具循环。均不进行真实调研或计费调用，同机分进程不证明物理隔离。原开发入口的去重仅在进程内有效；私有入口持久保存业务事实，但不恢复 Worker 内部执行状态，未知工作不会自动重跑。

Linear 用于内部开发规划；本仓库保留公开设计与后续实现。暂不建立重复的 GitHub issue 任务账本。

## 名称与许可状态

CoSeat（同席）为当前工作名称，商标、同名产品及域名核查尚未完成。仓库路径暂保留 `ai-native-workspace`，不代表最终品牌路径。

项目已确定开源方向，但本仓库尚未选择并发布项目许可证。公开可见不等于已经授予开源使用许可；上游组件及其依赖的许可证、集成方式仍需在采用前审核。
