# VIT-134：远端完整 Windows 研发门禁

本草案把 [VIT-133 本地门禁](development-quality.md) 接到 GitHub Actions，不替换门禁，也不接发布、支付、真实模型或生产服务。
新增 workflow 不等于远端验证成功。首次发布后仍须检查该 **实际 SHA** 的 Actions 原始记录、七项结果及产物。
分支保护、required checks 和评审权限属于后续 VIT-135，须单独确认；本代码不会修改这些设置。

## 触发与源码绑定

- `pull_request` 指向 `main`，处理 opened / synchronize / reopened / ready_for_review / edited。没有路径过滤，文档修改也运行完整门禁。
- PR 检查 `${github.sha}` 对应的 GitHub 合成 merge commit，不把 PR head 与 merge SHA 混用。脚本验证实际 checkout HEAD、完整 base/head SHA、两个 parent 的顺序和值：第一 parent 为 event 的 base SHA，第二 parent 为 PR head SHA。报告中的 head 是合成 merge SHA，PR head 另存于准备上下文。
- `push` 仅检查 `main`：head 必须同时等于 event.after、GITHUB_SHA 和实际 HEAD，base 固定 event.before。base 可以跨多个提交，只要求是真实祖先，不限 immediate parent。
- 删除分支、全零 before 的首次 push、不存在的提交和非祖先 force push 明确失败，不回退成 `base=head` 或任意 merge-base。首次建立 main 需另行评审基线策略。
- checkout 使用完整历史、精确 event SHA、`persist-credentials: false`，不启动 submodule/LFS，不修改全局 safe.directory。脚本在准备前后、最终验证时重复核对 event、HEAD、tree、祖先关系和干净工作区。
- 同一 PR 或 main 的新运行取消旧运行。取消是取消，不是通过；不以旧 SHA 的绿灯替代新 SHA。

## 单一 hosted Windows job，准备和检查分开

稳定 job 名为 `Complete Windows gate`，运行在 GitHub-hosted `windows-2025` x64，整 job 最长 90 分钟。无 Linux 局部通过冒充完整 Windows 通过，无 self-hosted runner。

1. 官方 setup-node 读取 `.node-version` 的精确版本，目前 **24.14.0**；准备脚本再次核对 `process.versions.node`。不启用 npm 自动 cache。
2. 先独立运行 `node --test scripts/ci.test.mjs`，验证 CI 事件、失败关闭和证据契约。这里的 PASS manifest 是明确的**合成测试 fixture**，不是一次真实门禁通过。
3. `scripts/ci-prepare.mjs` 单独准备环境，最长 25 分钟：
   - 用 runner 已安装的官方 rustup 安装明确的 `1.95.0-x86_64-pc-windows-msvc`，minimal profile 加 rustfmt/clippy。使用 job 级 RUSTUP_TOOLCHAIN，不运行 `rustup default` 或改用户电脑配置。1.95.0 与当前本地 Rust 验证版本一致，高于 Cargo.toml 的 1.90 最低要求。
   - `npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund`，依赖与完整性校验来自已提交 package-lock.json。通过当前 Node 直接调用 npm CLI，不使用 shell/npx 下载任意命令。
   - 通过锁定依赖中的 Playwright CLI 安装 Chromium。浏览器版本由 package-lock 和 Playwright 浏览器清单决定，不使用 runner 预装 Chrome。
   - `cargo fetch --locked --target x86_64-pc-windows-msvc` 准备 Cargo.lock 的依赖。
   - 运行现有 `npm run desktop:prepare`：构建所需 JS、准备 `.desktop/runtime/` 与 notices。此阶段设置 CARGO_NET_OFFLINE=true。现有脚本从 nodejs.org 下载 **24.22.2** Windows runtime，验证 archive SHA-256 `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2` 和 node.exe SHA-256 `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`。CI 额外复核 node.exe hash。此 bundled runtime 不等于执行门禁的 Node 24.14.0。
   - 最后验证 Cargo 完整离线 metadata 及干净 checkout。安装失败不进入门禁，也不降级为部分检查。
4. 单独执行原有接口，不传 `--only` / `--skip`：

   ```text
   npm run quality:gate -- --base FULL_EVENT_BASE_SHA --head FULL_CHECKOUT_SHA --output NEW_RUNNER_TEMP_DIRECTORY
   ```

   七项必须全为 PASS：unit、web、eval、browser、rust-fmt、rust-test、rust-clippy。Rust test/clippy 仍用原门禁的 `--locked --offline`。
5. 保留 gate 非零退出码。stage 复制后和紧接上传前的 bundle step 均复核白名单、精确文件集及 gate/staged 的逐文件字节，失败不进入上传；部分失败报告仍可作为非通过证据上传。最终校验要求 prepare/gate/stage/bundle/upload 全部 success，manifest 完成、Windows x64、七项完整 PASS、exitCode=0、无 setup/integrity/sourceEvents 错误、source.verifiedAtEnd=true、base/head/tree/关键输入 hash 和实际 checkout 一致。gate 原目录与 staged 上传副本必须有相同 manifest 字节及精确的文件集，两边逐份重算日志字节数和 SHA-256；副本被改或增加文件也失败。缺失、截断、取消、跳过、超时及 SETUP-ERROR 都不能变绿。

npm cache、Chromium、Cargo target 仅放在本次 runner.temp 的唯一 run ID / attempt 目录，没有跨运行或跨分支 cache 恢复/保存。Cargo registry 和工具链使用这台临时 hosted runner 的普通工具目录。
当前 lock 中带安装脚本标记的包已检查：@google/genai 2.21.0 的 preinstall 为 echo no-op，protobufjs 7.6.6 的 postinstall 只读取版本约束并打印兼容提示，fsevents 2.3.2 是 Darwin 可选包、不会装到 Windows。未发现本门禁需要运行的 native postinstall；依赖或 lock 变更须重新核查，不能把当前结论当作任意未来依赖都支持 ignore-scripts 的保证。
Node options 注入被显式拒绝，而不是偷偷过滤测试。CI 运行合成/localhost 测试，不提供真实模型、支付或生产凭据。依赖准备需要外网；这不是网络隔离沙箱，不宣称阻止恶意 PR 自行访问网络。

## 权限、action 固定与产物

- workflow 只有 `contents: read`，没有仓库写权限、管理权限、OIDC、deployment environment 或自定义 secrets；fork PR 不接收仓库 secrets。没有 pull_request_target、workflow_run、发布或管理 API。
- 仅使用三个官方 GitHub actions。2026-11-11 通过官方 GitHub API 核对 release tag、commit 对象和 action.yml，三者 runs.using 均为 node24：

  | Action | 固定完整 commit |
  | --- | --- |
  | [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
  | [setup-node v7.1.0](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1) | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
  | [upload-artifact v7.0.2](https://github.com/actions/upload-artifact/commit/cf430e030ddbb5b0abf93d22962f4752f3646cd9) | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |

- [官方 windows-2025 工具清单](https://github.com/actions/runner-images/blob/f29ba3467ba9178a9056047adcf7211c03321b28/images/windows/Windows2025-Readme.md) 已核对 Rust/rustup、Visual Studio MSVC 和 Windows SDK。hosted 镜像和 runner 版本会滚动，本草案没有将镜像固化为可重现 VM。首轮要验证当前 runner 支持三个 node24 action，以及真实 Windows 编译/浏览器工具是否齐备。
- 上传前只从指定 gate output 取平面白名单：manifest.json、七项检查 stdout/stderr、固定 setup/final probe 日志。拒绝额外文件、路径穿越、非普通文件/目录、符号链接、hard link 及超 256 MiB 的产物；复制到独立 artifact 目录，不扫描整个 checkout。
- 产物保存 **3 天**，没有文件则失败，不覆盖同名产物。失败但有部分 gate 证据时也上传，文件不会因此变成 PASS。准备失败或取消时，可能只有 Actions step 日志，没有完整 gate 产物。
- 不上传 node_modules、浏览器 profile、trace、视频、截图、runtime、Cargo target、用户配置或完整环境。测试日志仍可能包含路径/合成认证字段；公开仓库日志/产物可被有相应访问权限的人查看，不能把隐私日志直接带进测试。

## 信任边界与独立评审

PR 作者也能修改该 PR 中的 workflow、CI helper、门禁及测试。上述校验减少正常研发中的 SHA 混淆、缺证据、跳过及部分假绿，不是对恶意 PR 不可伪造的安全证明，也不是签名供应链证明。manifest/hash 与代码都可由同一执行身份改变。
不要只靠 manifest 校验就声称 PR 作者无法篡改门禁。必须独立审查 workflow/gate/test 改动；保护 workflow、评审权限与 required check 策略在 VIT-135 另行确定。不开启任何自动分支保护、自动合并或部署。

## 本地验证与远端首轮验收

本地入口：

```text
node --check scripts/ci-quality.mjs
node --check scripts/ci-prepare.mjs
node --test scripts/ci.test.mjs
```

测试涵盖真实临时 Git 仓库的多提交祖先和 merge 双 parent、错误 event/head、dirty checkout、所有非 PASS 状态、缺失/重复项、未完成报告、失败/取消/跳过的 step、输入/日志 hash、截断/缺日志、产物额外文件与目录类型。目录-link 拒绝分支以 lstat policy fixture 测试；某些受管本地沙箱禁止创建真实 Windows junction，因此不把这个 fixture 写成实际 junction 端到端验证。

远端尚未运行，首次经授权推送后要实际确认：

1. 正常 PR（含 fork）在只读权限下 checkout 精确合成 SHA，确认两个 parent；main 多提交 push 的 before/after 绑定正确。
2. 全新 hosted Windows 能下载固定 Node/Rust、npm/Chromium/Cargo 依赖并完成 runtime hash/notices 准备。准备不修改 tracked 文件。
3. 全七项真实运行并逐项审阅原始日志，确认超时预算、Windows 编译工具和当前依赖组合可用。
4. 有意构造的失败/缺资源/缺 manifest/篡改 log/缺项 fixture 真实使 job 非绿；取消旧 run 后没有误通过；不得把这些合成失败当作产品 bug 复现。
5. 产物只有 allowlist 内容、三天保留、生效 SHA/tree 与最终报告一致。准备失败/取消路径按预期留下非成功状态。

以上远端验证未完成前，只可称“本地已验证的 CI 草案”，不可称“远端 CI 已绿”或“可自动合并”。
