# Windows 发布流程

## 默认流程：本地打包，再上传 GitHub

1. 确定代码和新版本，运行 `node scripts/release-preflight.mjs`。回归使用临时 HOME、空白认证目录和 `PI_OFFLINE=1`，不继承个人账户或 API 密钥。
2. 提交并推送 main，确认 CI 成功。发布输入必须对应已提交源码；已公开版本的内容有变化时使用新版本。
3. 在本机 Windows 执行 `npm run dist:local`。这一步只构建；等待 electron-builder 正常退出，保留 `dist/Pi-Halo-Setup-<版本>.exe`、配套 blockmap 和 `dist/latest.yml`。
4. 设置 `HALO_PACKAGE_STAGE` 为仓库外新的隔离验证目录（例如系统临时目录），运行 `node scripts/verify-release-artifacts.mjs`。验证真实安装包内的版本、当前源码、资源、blockmap、大小与 SHA-512。读取 `test/results/release-artifacts.json` 中的 `stagedExe`，作为下列测试的 `HALO_PACKAGED_EXE`。
5. 执行打包版检查：`verify-packaged-runtimes.mjs`、`e2e-bundled-pi.mjs`、`verify-office-packaged.mjs`、`e2e-packaged-proxy.mjs`（代理与 `--expect-direct` 两种模式）、`e2e-ui-motion.mjs`，均位于 `test/e2e/`。安装器界面有变更时完成真实原生安装向导检查。
6. 门禁全部通过后创建并推送版本标签；不移动旧标签。设置 `RELEASE_TAG=v<版本>` 和 `GITHUB_REPOSITORY=13075061852/WebPi`，使用已认证 GitHub CLI 执行 `./scripts/upload-release.ps1`。它核对本地产物哈希并上传同一组文件到草稿。
7. 核对远端三个资产与本地报告匹配后发布 Release，再检查匿名 latest.yml 和旧版本更新发现。报告本地安装包的绝对路径、版本、Release URL 与阶段耗时。正式发布完成时本地 dist 必须保留这组产物。

标签推送不再自动触发云端打包。`.github/workflows/release.yml` 只作为手动后备，用户明确要求云端构建时才运行；它仍使用 build → verify → upload 与保留候选产物的机制。

本地验证或上传失败时，保留成功构建的安装包。修复验证环境后只重做验证，网络恢复后只重做上传；应用与构建输入变化才重新构建。上传脚本依赖 GitHub CLI，缺少时先准备 CLI 或使用等效、带产物哈希核对的 GitHub API 上传流程，不要改为云端重新打包。

## 失败恢复

- 上传或 GitHub 网络失败：选择 **Re-run failed jobs**（或 `gh run rerun RUN_ID --failed`），复用已验证的构建产物，只重试 upload，不重新安装依赖或打包。产物保留 14 天。
- 打包版验证偶发失败：选择 **Re-run failed jobs**，只重跑 verify 及后续 upload，build 产物原样复用。
- CI/测试脚本有误，应用内容未变：修复 scripts/test/workflow 后推送 main，从 main 手动运行 Windows release，输入原有未发布标签，并在 `reuse_run` 填入已成功构建且保留 `windows-candidate-installer` 的任务 ID。工作流检查 `src`、`assets`、`package.json`、lockfile、`build` 与标签完全一致。验证来源必须是同仓库发布工作流、build 成功且应用输入与当前代码完全一致；复用后仍重新校验安装包并执行打包版测试。无需只因测试修复而升版本或改写标签。旧流程没有候选产物或产物已过期时才重建。
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
- 构建成功立即以零压缩上传候选包。验证失败重跑 verify；测试修复后用 reuse_run；上传失败仅重跑 upload。禁止因为测试/上传失败重建相同输入。
- 发布流程的新检查先本地验证，明确云端字体、PowerShell、代理、可见性和动画偏好，不在发布时临时添加未验证的环境假设。
- 发布后只下载小型验证报告及 latest.yml 核对远端 digest；无需反复下载完整 EXE。只有用户需要本地包或确有本地打包版检查需要时下载。
- 每轮发布报告阶段耗时与失败原因。优先消除重复工作，不以跳过质量门禁换速度。
