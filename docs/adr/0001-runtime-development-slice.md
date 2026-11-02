# ADR 0001：开发切片暂用 pi SDK 1.4.0

日期：2026-11-02。状态：开发原型的临时采用；不是用户锁定长期供应商的决定。项目许可证、正式自主授权、真实模型和部署另行决定。

## 问题与选择

首个闭环需要把授权线程中的自然消息接到后台执行，并带来源回原线程。运行时只负责有边界的执行；CoSeat 保留身份、会话、授权、参与策略、认领和回执。

本切片选择 `@earendil-works/pi-coding-agent@1.4.0` 与 `@earendil-works/pi-ai@1.4.0`，MIT；`typebox@1.3.27` 为工具 schema 依赖。版本来自官方 npm 并由 lockfile 固定。开发工具为 TypeScript 5.9.3、Node types 24.10.0。Node 24.14.0 完成实测。尚未完成完整依赖许可/安全采用审计，MIT 上游不决定 CoSeat 的项目许可证。

首轮只比较本切片的受控接入成本，未做模型质量、性能或成本竞赛：

| 候选 | 固定源码所见 | 对这次切片的影响 |
| --- | --- | --- |
| pi SDK 1.4.0 | 可注入 ResourceLoader、ModelRuntime、内存 Settings/SessionManager；显式工具白名单；prompt/abort/waitForIdle 与事件 | 能直接关闭本切片不需要的资源发现与后台行为；实现一个薄执行函数即可 |
| Deep Agents JS 1.16.2 | `createDeepAgent` 默认装配文件系统、subagent、摘要等 middleware；自定义 tools 为追加；异步 subagent 有额外服务协议 | 本切片不需要这些能力；精确收窄默认工具和 middleware 需要更多配置核验，暂不实现 |

“受控代码更少”是基于源码接口的工程判断，不是已经完成两套 adapter 的量化比较。Deep Agents 仍是后续候选；其 Python 0.7.32 与 JS 1.16.2 是独立版本，不能把滚动文档当作两个固定包的相同行为。pi 本身支持持久会话；只是本插件没有暴露恢复，不能声称 pi 没有恢复能力。

## 已实施的收窄

- 自定义空 ResourceLoader：不发现用户/项目 skills、AGENTS、扩展、提示模板或 MCP；测试放入环境文件后仍只有四个 CoSeat 工具。
- 只开放 `read_messages / send_message / claim_task / request_approval`；检查实际 active tools，与工作包不一致就拒绝运行。禁用内置 shell、文件编辑及其他工具。
- 内存 credential/model/settings/session store；`modelsPath: null`，关闭模型目录网络刷新，显式注入模拟模型；不读取个人持久模型凭据。
- 禁用自动重试（含 provider retry）、自动压缩、缓存预热、安装遥测与 analytics。
- 取消调用 SDK `abort()` 并等待执行结束，再发布 stopped 证据。追加输入、暂停、重启恢复及 checkpoint 都明确为不支持。
- 普通后台调度由 CoSeat 与独立 Worker 进程实现，不引入 Deep Agents async subagent 服务、dsh/Cordis、OpenViking 或通用工作流引擎。

## 验证与未验证

已跑真实 pi SDK 的四轮模拟模型循环：读消息工具 → 确认认领工具 → 发消息工具 → 完成文本；每轮核对上一轮真实工具结果，没有把 SDK 实例化当作集成完成。也跑过 SDK 中途取消，以及 fake / pi-mock 两种独立进程闭环。网络模型、真实网页研究、长任务压缩、真实服务端取消效果、持久恢复和跨设备安全尚未验证。

模型工厂是显式注入点。可运行入口仅接受 fake/pi-mock；真实模型调用需要以后明确配置模型、预算、凭据和可访问来源。本次没有配置、扩大或复用模型凭据，没有计费模型请求。

## 参考与采用范围

- [pi 1.4.0 package manifest](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/package.json)
- [pi 1.4.0 SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md)
- [pi 1.4.0 完整控制示例](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/sdk/12-full-control.ts)
- [Deep Agents JS 1.16.2 factory](https://github.com/langchain-ai/deepagentsjs/blob/deepagents%401.16.2/libs/deepagents/src/agent.ts)
- [Deep Agents 异步 subagent 文档（滚动）](https://docs.langchain.com/oss/python/deepagents/async-subagents)

本决定只解锁受限原型，不关闭 VIT-102，也不替代其他 M0/M1 依赖。第二 harness 应等这一切片被审阅后，用同一协议和验收集验证可替换性。
