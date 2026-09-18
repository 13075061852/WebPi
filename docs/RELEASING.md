# Windows 发布流程

## 发布前

1. 确定本次代码和版本，运行 `node scripts/release-preflight.mjs`。
2. 预检必须成功。回归使用临时 HOME、空白认证目录和 `PI_OFFLINE=1`，不继承 API 密钥；首个失败立即终止。需要真实账户的测试（如 `verify-image-runtime.mjs`）不可加入离线列表。
3. 提交并推送 main，等该提交的 CI 成功、Windows 依赖预热完成后，再创建并推送对应版本标签。不要把未经 CI 检查的 main 和标签一起推送。
4. 标签触发 Windows release。只有打包、哈希/源码校验及打包后运行检查全部成功，产物才会交给独立 upload 作业。

## 失败恢复

- 上传或 GitHub 网络失败：选择 **Re-run failed jobs**（或 `gh run rerun RUN_ID --failed`），复用已验证的构建产物，只重试 upload，不重新安装依赖或打包。产物保留 14 天。
- CI/测试脚本有误，应用内容未变：修复 scripts/test/workflow 后推送 main，从 main 手动运行 Windows release，输入原有未发布标签。工作流检查 `src`、`assets`、`package.json`、lockfile、`build` 与标签完全一致。无需只因测试修复而升版本或改写标签。
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
