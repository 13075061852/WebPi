# Windows 发布流程

日常修复、界面调整、依赖及 Pi 内核升级只改源码并验证，不升应用版本、不打包、不推送。
只有用户明确要求“推送/发布最新版本”时才开始下述流程，按最新正式 Release 确定下一版本。
用户单独要求测试安装包时，只生成该测试包，不改变正式版本号、不发布。

## 默认流程：本地准备与 CI 并行，再上传 GitHub

1. 按最新正式 Release 确定新版本。先用 `scripts/Invoke-GitHub.ps1 -GhArguments @('api','repos/13075061852/WebPi','--jq','.full_name')` 确认 CLI、认证和仓库访问；可用 `HALO_GH_PATH` 指定 CLI。凭据只在子进程内存使用，不写日志或文件。
2. 运行 `npm run release:preflight`，通过后提交并推送 main。预检使用隔离账户；静态语法、ESLint、跨平台夹具检查并行，功能及 GUI 回归串行。源码检查清除 `HALO_PACKAGED_EXE` 等残留控制变量，防止误测旧包。
3. 执行 `npm run release:local`。它检查干净且已推送的 main、版本一致性、GitHub 访问，并行等待**当前完整提交 SHA 的 CI**与本地准备。相同输入且不足 24 小时的成功预检直接复用；否则重跑预检。然后本机打包（不发布）、仓库外解包校验、6 项打包版测试，全部通过才输出 `READY`。
4. 成功构建的候选包按应用/构建输入指纹和本地文件 SHA-256 留存；CI、测试或网络失败后重跑同一入口。应用/构建输入不变且产物哈希一致时复用 EXE；测试变化会重跑验证。该入口不提交、不打标签、不上传、不正式发布。安装器界面有变更时仍须完成真实原生安装向导检查。
5. 核对 `test/results/release-local.json` 为当前提交且 `passed: true` 后，创建并推送新的版本标签。设置 `RELEASE_TAG=v<版本>`、`GITHUB_REPOSITORY=13075061852/WebPi`，执行 `scripts/Invoke-GitHub.ps1 -ScriptPath scripts/upload-release.ps1`。它用同一 CLI/认证入口上传草稿：匹配 SHA-256、大小和 uploaded 状态的远端资产跳过，缺失/不符项才传；断线先查远端，单项最多尝试三次。
6. 上传脚本成功确认三个资产的哈希、大小、状态后，使用同一 CLI 包装入口为草稿设置更新说明并正式发布为 latest。保留本地 EXE、blockmap、latest.yml；下载匿名 `releases/latest/download/latest.yml` 并与本地哈希比较。
7. 运行 `node scripts/verify-public-update.mjs --installer dist/Pi-Halo-Setup-<上一版>.exe --from <上一版> --to <新版本> --manifest dist/latest.yml`。它使用真实旧安装包和旧 updater 匿名查询正式源，禁止下载/安装，核对新版本、SHA-512 和大小。报告本地绝对路径、版本、Release URL、提交与阶段耗时。

流程预览：`npm run release:local -- --plan` 不构建、不访问网络、不修改远端。

### 单阶段恢复与证据

- `test/results/release-preflight.json`：完整预检结果、前后输入指纹与逐项时间。源码、测试、脚本、工作流、构建配置、运行时或本地依赖变化即失效；超过 24 小时也重跑。
- `test/results/release-candidate.json`：成功构建的应用/构建输入指纹和 EXE、blockmap、latest.yml、ASAR 哈希。文件名含同一个版本不代表内容相同。
- `test/results/release-local.json`：当前提交 CI、本地阶段结果、真实进程/阶段耗时和复用情况。失败重试会覆盖旧成功标记。全部 gates 成功后才允许标签/发布。
- `test/results/release-artifacts.json`：实际安装器校验及仓库外 `stagedExe`；`packaged-release-checks.json` 记录 6 项真实进程耗时。
- 只重跑包测试可用 `npm run release:verify`，读取已校验的 `stagedExe`，也可设置 `HALO_PACKAGED_EXE`；这不会取代安装器哈希/源码校验或 CI。
- 上传失败只重跑包装入口的 `upload-release.ps1`；匹配资产不重新传输。最终状态不明确时先读取 Release，再决定补传或继续核对。
- 如果手动构建：仍用 `npm run dist:local`，设置仓库外全新 `HALO_PACKAGE_STAGE` 后执行 `node scripts/verify-release-artifacts.mjs`，随后 `npm run release:verify`。保留所有门禁；不要另写版本专属 tmp 发布脚本。

标签推送不再自动触发云端打包。`.github/workflows/release.yml` 只作为手动后备，用户明确要求云端构建时才运行；它仍使用 build → verify → upload 与保留候选产物的机制。

本地验证或上传失败时，保留成功构建的安装包。修复验证环境后只重做验证，网络恢复后只重做上传；应用与构建输入变化才重新构建。上传脚本依赖 GitHub CLI，缺少时先准备 CLI 或使用等效、带产物哈希核对的 GitHub API 上传流程，不要改为云端重新打包。

## 失败恢复

- 本地默认流程：测试/CI 失败修复后运行 `release:local`，按输入及哈希复用候选包；上传失败只重试上传入口。
- 以下 `Re-run failed jobs`、`reuse_run` 仅用于用户明确指定的云端后备流程，不因本地失败自动切换云构建。
- 云端上传或 GitHub 网络失败：选择 **Re-run failed jobs**（或 `gh run rerun RUN_ID --failed`），复用已验证的构建产物，只重试 upload，不重新安装依赖或打包。产物保留 14 天。
- 云端打包版验证偶发失败：选择 **Re-run failed jobs**，只重跑 verify 及后续 upload，build 产物原样复用。
- 云端 CI/测试脚本有误，应用内容未变：修复 scripts/test/workflow 后推送 main，从 main 手动运行 Windows release，输入原有未发布标签，并在 `reuse_run` 填入已成功构建且保留 `windows-candidate-installer` 的任务 ID。工作流检查 `src`、`assets`、`package.json`、lockfile、`build` 与标签完全一致。验证来源必须是同仓库发布工作流、build 成功且应用输入与当前代码完全一致；复用后仍重新校验安装包并执行打包版测试。无需只因测试修复而升版本或改写标签。旧流程没有候选产物或产物已过期时才重建。
- 应用代码/构建输入确实变化，或版本已经公开：使用新版本。已发布资产不可覆盖，标签不可移动。
- 构建失败：修复后重跑构建；不能以跳过校验换取速度。

## 缓存和校验

- 默认分支预热 Windows node_modules；标签构建可继承。缓存绑定 Windows 2025、CPU 架构、Node 精确版本、lockfile 和安装脚本。只改项目版本不会失效；依赖或安装脚本变更会失效。只用精确命中，不使用宽松 node_modules 回退。
- Electron/NSIS 下载缓存独立维护。首次冷缓存仍需要完整安装，后续收益以 Actions 的实际步骤耗时为准。
- 构建后保留未再压缩的 EXE、blockmap、latest.yml 和校验报告。upload 再核对 SHA-256，然后上传草稿。
- 发布前检查远端三个资产与报告匹配；根据 UI 变更执行打包版启动/动画检查。需要本地安装包时再下载，不要为了轮询状态反复下载整包。
- 最终公布 Release 后验证匿名 latest.yml 和旧版本发现新版本。记录提交号、Release URL 与验证结果；不记录凭据。

## 2026-09-18 基线

1.0.6 Windows 工作流：依赖安装 152 秒、NSIS 构建 150 秒、回归 48 秒、包校验 23 秒、打包后检查 45 秒、上传 19 秒。这些是优化前实测，不是新流程的速度承诺。

## 2026-09-29 发布复盘与耗时控制

1.0.10 最终成功任务 `36573465196` 的步骤耗时：依赖缓存 27 秒、语法检查 15 秒、Windows 回归 53 秒、打包 157 秒、安装包校验 22 秒、打包版测试 95 秒、上传 19 秒。排队和 runner 启动另计，不能承诺固定总时长。

本次额外消耗来自两轮打包后测试失败：代理夹具仍沿用环境变量行为，以及云端 Windows 动效环境与本地不同。程序源码未变，却重复构建三次。

后续要求：
- 本地 release-preflight 在 Windows 提前跑保存的代理/直连模式和动效源代码测试。动效显式启用动画并确保窗口可见；保留真正打包版验证，不能拿源代码测试替代。
- 语法检查最多 4 个进程并行；不并行争用前台窗口的 GUI 测试。
- main 的 CI 和依赖预热并行等候；门禁成功后才推标签。不要串行重复启动已经通过且代码未变的检查。
- 云端后备构建成功立即以零压缩上传候选包。验证失败重跑 verify；测试修复后用 reuse_run；上传失败仅重跑 upload。禁止因为测试/上传失败重建相同输入。
- 发布流程的新检查先本地验证，明确云端字体、PowerShell、代理、可见性和动画偏好，不在发布时临时添加未验证的环境假设。
- 发布后只下载小型验证报告及 latest.yml 核对远端 digest；无需反复下载完整 EXE。只有用户需要本地包或确有本地打包版检查需要时下载。
- 每轮发布报告阶段耗时与失败原因。优先消除重复工作，不以跳过质量门禁换速度。

## 2026-10-08 / 1.0.13 复盘与预防

| 已确认原因 | 前置预防 / 恢复方式 |
|---|---|
| 1.0.13 测试显式注入 win32，却用 process.platform 判断预期；本机通过、Linux CI 失败 | 日常 `npm run check:source` 的 AST 检查拦截同一断言里的这种混用；平台/架构夹具显式给路径与预期；保留真实 Linux CI。修复提交为 50230e9。 |
| 1.0.10 代理夹具仍沿用旧环境变量，云端动画偏好/窗口可见性与本机不同 | 夹具跟随当前保存的代理模式；动画显式开启，GUI 串行；预检和打包版都测。 |
| 已成功的构建在测试失败后被重跑；同版本旧报告容易误用 | 按当前文件内容指纹、产物哈希判断复用；测试变化只使验证失效。绝不只看版本名。 |
| gh 不在 PATH 或未认证，原先到上传阶段才临时处理 | 昂贵阶段前统一解析 CLI 并验证认证/仓库；准备与上传共用可用的认证方式。 |
| 手动串行等待和临时脚本反复读取状态，缺少可信阶段时间 | checked-in runner 并行等待 CI 与本地准备，自动交接解包和包测试，记录阶段时间与复用。 |
| --clobber 重试全部资产，即使 EXE 已上传 | 按 digest/大小/状态复用，只补缺失或错误项；连接失败后先核对服务端结果。 |

本轮原始观测：预检 138 秒；CI 含修正重跑 253 秒（成功 job 本身 89 秒）；本机打包 94 秒；安装包校验及打包测试 147 秒（六项子测试合计 82.516 秒）；上传/核对 168 秒（EXE 服务端传输时间约 143 秒）；正式发布/更新检查 119 秒。观测包含部分轮询和交接，不能将差值全部视为可消除的等待。

优化不降低原有门禁：不省略真实安装器校验、仓库外运行检查、GUI 测试、精确提交 CI、远端哈希或旧 updater 检查。可减少串行等待、重复预检/打包、重复上传和字体安装；带宽、冷缓存和 runner 排队仍影响总耗时。下次实际发布记录冷/热缓存及复用情况后再比较端到端时间，不提前承诺固定分钟数或零失败。
