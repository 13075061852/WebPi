# 开发指南

[返回项目首页](../README.md) · [全部文档](README.md)

## 环境与启动

源码开发需要 Node.js ≥ 22.19.0、npm 和 Git。当前主要支持 Windows x64；其他平台的终端和系统集成需单独验证。

```bash
npm ci
npm start
```

依赖版本由 `package-lock.json` 固定。首次安装需能下载 Electron 二进制。应用优先使用随包内核；需要调试其他 Pi SDK 时，可通过 `PI_HALO_PI_PATH` 显式指定入口。

已有 Pi 用户共用 `~/.pi/agent/` 下的认证、模型、技能和扩展。测试应使用隔离配置，避免改动个人账户及真实项目。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 窗口、Pi SDK、账户、项目服务、文件与更新逻辑 |
| `src/preload/` | 渲染层可调用的受控 IPC API |
| `src/renderer/` | 原生 HTML/CSS/JavaScript 界面与本地文件预览 |
| `assets/` | 图标、技能、主题及办公示例 |
| `scripts/` | 启动、检查、构建及发布工具 |
| `test/` | 离线回归、Electron 验证与调试工具 |
| `docs/` | 使用、开发、发布说明及历史验证记录 |

`node_modules/`、`dist/`、`tmp/` 及可再生成的测试截图和日志不纳入版本管理。

## 检查与测试

```bash
npm run check          # 全量语法检查（node --check 遍历 src/scripts/test）
npm run lint           # eslint 静态检查
npm run test:inject    # 预览注入脚本语法（离线）
npm run test:regressions # 离线功能回归：项目/账户隔离、用量、输入消息和文档预览，无需模型账户
npm run test:render    # 注入模拟 pi 事件流 + DOM 断言 + 截图（test/e2e/）
node test/e2e/verify-stream-render.mjs  # 流式 markdown 增量渲染与全量渲染等价性
node test/e2e/e2e-environment-settings.mjs # 实际 Electron 检测 + 模拟安装交互，不安装系统软件；加 --packaged 检查打包版
npm run test:treewatch # 文件树 watcher：外部改动自动刷新
npm run test:multisession    # 多会话并发：A 后台执行中切 B 发任务，验证不中断 + 徽标 + 切换保留（真实模型）
npm run test:multisession-ui # 多会话 UI 级：执行中新建会话、running 徽标、切回后结果渲染（真实模型）
npm run test:reallink  # 真实链路：真实 prompt → IPC → 实时渲染（需已登录模型）
npm run test:workspace # 真实链路：agent 创建页面 → 自动预览 + 文件树 + 改动标记
```

- `test/e2e/`：维护中的端到端/单元验证套件（npm scripts 入口）
- `test/tools/`：历史探针与一次性调试脚本（`verify-*` / `shot-*` / `dbg-*` 等）
- 截图输出到 `test/shot-*.png`，测试日志输出到 `test/results/`；这些可再生成的文件不纳入版本管理。CI（GitHub Actions）执行源码检查及离线回归；具体范围以 `.github/workflows/ci.yml` 为准。

离线回归不需要个人模型账户；标注「真实模型」或「需已登录模型」的检查可能产生模型用量。GUI 检查应顺序执行，避免窗口抢占焦点。

## 运行架构与原生依赖

```
src/
  main/main.mjs        Electron 主进程：启动动画调度、窗口、IPC 路由、文件树 watcher
  main/pi-bridge.mjs   pi SDK 桥接：createAgentSessionRuntime 完整规则内嵌、多账户凭据库（safeStorage 加密）
  main/inject/         预览帧注入脚本（触摸模拟 / 滚动条美化，独立文件便于 lint）
  preload/preload.cjs  contextBridge 受控 API
  renderer/            三栏 UI（原生 HTML/CSS/JS，零框架依赖）
    js/theme.js       首帧前主题绘制（防闪色）
    js/markdown.js    markdown-lite 渲染 / 语法高亮 / 流式增量渲染
    js/app.js          pi 事件流 → UI 映射
    splash.html/css/js 启动动画
```

渲染层使用原生 HTML/CSS/JavaScript，无需前端框架构建步骤；主进程通过 Pi SDK 管理会话，并经受控 IPC 向界面转发事件。

### Windows 原生模块与打包验证

Windows x64 包使用 node-pty 自带的 Node-API 预编译模块（保留 asarUnpack），关闭 electron-builder 的重复编译，避免 SSH 可选 CPU 检测模块要求本机安装 Visual Studio。升级原生依赖后应重新验证打包产物：

```powershell
npm run dist:dir # 仅在明确需要本地测试包时执行
$env:HALO_TEST_EXECUTABLE = "dist/win-unpacked/Pi Halo.exe"
node test/e2e/e2e-terminals.mjs
Remove-Item Env:HALO_TEST_EXECUTABLE
```

## 构建与发布入口

日常修复只修改源码并运行相关检查，不修改正式版本号、不生成安装器、不推送或发布。只有明确要求测试安装包或正式发布时，才进入对应流程。

- 测试包：按请求使用 `npm run dist:dir` 或 `npm run dist:local`，不更改正式版本、不上传。
- 正式发布：先阅读 [Windows 发布流程](RELEASING.md)，使用检查入库的预检和本地发布入口。
- 构建产物位于 `dist/`，正式安装器名称为 `Pi-Halo-Setup-<版本>.exe`。
- 打包包含固定版本 Pi SDK 与生产依赖，原生模块和运行依赖放在 `resources/app.asar.unpacked/node_modules`。
- 安装额外 npm/Git 来源插件仍需相应工具；普通对话不要求全局 Pi。

发布验证失败时，按发布指南判断哪些阶段需要重跑；不要仅因上传或网络失败而重建相同安装器。
