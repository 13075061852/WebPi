# Repository guidance

## 工作范围

- 日常修复只改源码和验证，不升版本、不打包、不推送。用户明确要求发布最新版时才执行下列流程；测试安装包不升正式版本、不发布。
- 默认本机 Windows 打包后上传 GitHub。只有用户明确要求云构建才使用手动云端后备；推标签不触发云构建。
- 发布或恢复前读 `docs/RELEASING.md`；只用仓库内脚本，不另写版本专用发布脚本，不移动已有标签，不覆盖正式资产。

## 快速发布（新窗口也按此顺序执行）

1. **先检查现场和网络**：查看 `git status`、`package.json`、远端最新正式版及 `test/results/release-{preflight,candidate,local,publication}.json`，优先续跑已有阶段，不丢弃未提交改动。
   用 `scripts/Invoke-GitHub.ps1 -GhArguments @('api','repos/13075061852/WebPi','--jq','.full_name')` 验证 CLI、认证和仓库访问，并验证 `gh run list --repo 13075061852/WebPi --workflow ci.yml --limit 1`（同一包装入口）。
   若 EOF/TLS 失败，先验证已有本地代理，仅为发布子进程设置 `HTTPS_PROXY`；不要改系统代理或打印凭据。端口必须实查，不能盲用 7890。
   CLI/`curl` 可访问不代表 Electron 更新器直连可用；先查上次 `release-publication.json` 的 `previousUpdater.networkMode`，上次需代理且本次代理实测可用时，公开更新探针直接带 `--proxy`。代理端口重新查，不照抄历史值。
2. **先测新增功能，再做安装包**：源码阶段完成受影响的真实交互、重启和迁移测试，失败先修，不要留到打包后才首次验证。
   浏览器记忆用 `npm run test:website-storage`；终端记忆用 `npm run test:terminal-memory`、`npm run test:terminal-input-history`；项目/对话恢复用 `npm run test:workspace-memory`。
   只跑受影响项，GUI 串行；源码测试前清除残留 `HALO_PACKAGED_EXE`。键盘测试等待真实回显，明确窗口可见和焦点，不能拿调试状态偶然通过当结论。
3. **定稿后一次预检**：按远端正式版确定新版本，`npm version <新版本> --no-git-tag-version`，补齐 `src/renderer/js/release-history-data.mjs` 已发布记录，并准备更新说明。
   执行一次 `npm run release:preflight`，不要再单独重复它包含的语法、lint、全量回归、代理/直连、动效检查。通过后提交并推送 main；此后不顺手改无关文件。
4. **统一入口准备安装包**：执行 `npm run release:local`。它并行核对当前完整 SHA 的 CI 与本地准备，复用输入未变且不足 24 小时的预检，自动构建、解包核对和运行 6 项打包版检查。
   不要另起 `dist` 或手动重复构建。确认 `test/results/release-local.json` 的 `passed: true`、`commit` 等于 HEAD。用报告的 `artifacts.stagedExe` 设置 `HALO_PACKAGED_EXE`，串行补测本次受影响的功能；结束后清除该变量。
5. **一次上传并发布**：通过全部检查才创建并推送新标签。设置 `RELEASE_TAG=v<新版本>`、`GITHUB_REPOSITORY=13075061852/WebPi`，运行 `scripts/Invoke-GitHub.ps1 -ScriptPath scripts/upload-release.ps1`。
   三个远端资产的 SHA-256、大小和 uploaded 状态核对成功后，用同一包装入口执行 `gh release edit <标签> --repo 13075061852/WebPi --notes-file <说明文件> --draft=false --latest`。只更新说明或网络失败不能重跑打包。
6. **公开验证后收尾**：匿名下载 `releases/latest/download/latest.yml` 与本地哈希比较；运行：
   `node scripts/verify-public-update.mjs --installer dist/Pi-Halo-Setup-<旧版本>.exe --from <旧版本> --to <新版本> --manifest dist/latest.yml`
   网络已确认需代理时追加 `--proxy http://127.0.0.1:<实查端口>`，不再重复尝试已知失败的直连。探针禁止下载或安装更新。
   全部成功后，才删除本地 dist 顶层旧 EXE 和对应 blockmap，保留最新版三件套、其它构建目录和 GitHub 历史。记录版本、提交、下载地址及阶段耗时到 `test/results/release-publication.json`。

## 失败只恢复必要阶段

| 失败原因 | 最小恢复动作 |
|---|---|
| CI 查询、上传、公开验证网络失败 | 先读远端状态；重试对应查询、上传入口或更新探针，不重建、不重打标签 |
| 草稿创建成功但列表暂未出现 | 查已知草稿/标签，重试原上传入口；哈希相同的资产自动跳过 |
| 只改测试或测试环境 | 重跑受影响验证及必要门禁；应用指纹和产物哈希未变就复用候选安装包 |
| 应用或构建输入改变 | 先完成源码功能测试，再更新提交并执行预检和 `release:local`，此时才需要重建 |

报告以当前输入指纹、完整提交 SHA、真实子进程时间和文件哈希为准，不以同版本文件名为准。CI 等待、人工调试、网络耗时分开记录；不靠跳过门禁提速。

## 日常回归约束

- 平台夹具跟随注入的平台和架构，Windows 路径显式给出；实际 Windows 集成才按宿主平台跳过。保留 x64、arm64、unsupported 覆盖和最终提交的 Linux CI。
- 依赖/Pi 内核升级同步检查 lockfile、真实导出和模型行为，及时更新旧 mock；不要到发布时才补。
- 离线测试隔离个人 HOME、认证和 Git 状态；代理测试配置应用保存的代理/直连模式，不靠继承环境变量冒充。
- 动效测试显式开动画、显示窗口，并提供中文字体和 PowerShell；前台 GUI 不并行。

## 耗时与提速经验

- 1.0.24 从预检到收尾约 16 分 33 秒：预检 256 秒、本地准备 210 秒（构建 107、包校验 23、打包版检查 69）、功能补测 22 秒、上传核对 302 秒。CI 69 秒已与本地准备重叠，不能重复相加；仅构建一次。
- 上传瓶颈是约 189 MB EXE 的传输（远端创建至完成 286 秒），不是重复构建。API 连通不代表上传快；未测对照不能认定代理更快，不为测速重复上传或下载整包。另记上传子进程总耗时和远端资产时间，区分传输与元数据核对。
- 旧更新器直连失败耗时 39 秒，已验证代理后成功耗时 20 秒；沿用上次有效网络模式并重新验证，可避免已知失败的直连。
- 长任务用一次 30–45 秒有界等待；完成后立即按门禁衔接下一阶段，避免反复 5 秒轮询和无关查询。阶段间隔含网络、人工交接及收尾，不能全部归为构建耗时。
- 预检变慢先看 `test/results/regressions.json` 的逐项耗时；本次 Store 代理、Git 仓库、环境后备测试分别约 50/41/28 秒。优化重复子进程须另行验证隔离和覆盖，不在发布途中改测试或跳门禁。
- 1.0.23 曾因打包后才发现终端问题造成三轮构建；继续坚持新增功能先实测、预检只跑一次、候选包复用、网络失败只恢复对应阶段。
