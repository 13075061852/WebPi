# Pi Halo · 星环

一款以 **pi 核心 agent** 为引擎的桌面可视化终端。pi 的一切规则原样保留 —— 扩展、技能、提示模板、AGENTS.md 上下文、会话树、消息队列（steer / follow-up）、压缩 —— 全部按 pi 自己的方式发现与加载；区别在于：你第一次能**看见** agent 在做什么。

![icon](assets/icon-rounded.png)

## 亮点

**黑白双色主题（墨 × 纸）**
极简单色设计：默认「墨」· 深黑底白墨水，右上角 ☀ 一键切到「纸」· 纸白底黑墨水；偏好自动记忆，启动无闪色。启动动画、工具卡片全套同步单色化，仅保留绿 ✓ / 红 ✕ 等语义色。

**高端启动动画**
黑色幕布上星尘从四方螺旋汇聚 → π 光环描边成形 → 双重冲击波扩散 → "PI HALO" 字标逐字浮现。期间 agent 核心已并行预热，动画结束即就绪。

**三区布局（参考 MiniMax Design）**

- 左栏：对话状态（呼吸光球实时反映 agent 忙闲）、会话历史、技能/模板/扩展清单、模型卡片
- 中栏：双标签页 —— **工作区**（项目文件树 + 会话改动追踪 + Diff 查看器）、**预览**（HTML/图片/Markdown 实时渲染，agent 生成页面时自动弹出）
- 右栏：流式对话面板 —— 思考过程展开流式滚动、工具调用卡片（spinner→✓/✕、diff 高亮、耗时）、引导/追加队列芯片、token 与费用统计
- 主题：`halo-theme`（localStorage，`dark` / `light`），标题栏 ☀/☾ 按钮或代码内 `applyTheme()` 切换

**多账户登录与额度切换（订阅登录旁的新能力）**
登录配置里每个供应商可保存多个登录身份（OAuth 订阅 / API Key 均可）：每次订阅登录成功自动存为一个账户，也可用「存为账户」手动保存当前身份；账户以芯片形式列在供应商下方，**每个芯片实时显示该账户的剩余额度**（订阅制 5h/7d 百分比、余额制金额、积分制分数，登录配置打开时自动拉取），**点击芯片即一键切换使用哪个账户的额度**（写回与 pi CLI 共享的 `~/.pi/agent/auth.json`，切换完成立即拉取新账户额度并同步模型快照，底部额度条与模型列表随之更新）。登出后账户仍保留在保管库中，随时可切回，无需重新走 OAuth。双击芯片可重命名，× 两次确认删除。保管库文件：`~/.pi/agent/halo-accounts.json`（与 auth.json 同目录、同等敏感，请勿外传）。

**工作区与预览**

- 工作区：实时项目文件树（忽略 node_modules/.git 等，含文件大小），agent 写入/编辑的文件自动高亮并进入“本次会话改动”列表，点击可查看全文或 diff
- 预览：通过本地 `halo-preview://` 协议安全渲染项目内文件；agent 生成 `.html` 时自动切换到预览页；支持在系统编辑器中打开

**多会话并发执行**
每个会话拥有独立的 agent 运行时（会话池，上限 6 个）：**任务执行中随时可以切换会话或新建会话去执行其他任务，切走的任务在后台继续跑**，不会因切换而中止。左侧会话列表带绿色脉冲徽标实时标注“执行中”的会话；切回后历史与结果完整保留。执行中的会话不可删除（需先 Esc 中止），池满时自动淘汰最久未用且空闲的会话。

**交互丝滑**
全部动画基于 `cubic-bezier` 弹性曲线：面板级联入场、消息浮升、按钮悬停抬升、发送键任务中渐变为中止键、玻璃拟态模态框。

## 运行

```bash
npm install        # 安装 electron（二进制需可访问 npm 镜像）
npm start
```

安装包内置固定版本的 `@earendil-works/pi-coding-agent` 和 Electron 自带的 Node 运行时，新电脑无需预装 Pi 或 Node 即可启动、登录并对话。已有 Pi 用户仍共用 `~/.pi/agent/` 下的认证、模型、技能和扩展；应用始终优先使用随包内核，避免全局 Pi 升级影响兼容性。Windows 未配置默认工具时使用系统 PowerShell 执行本地命令。

**设置 → 环境配置** 自动检测全局 Python 3、Node.js、Git 的版本和路径。点击「一键配置环境」通过 Windows WinGet 安装缺失工具：Python 3.14、Node.js LTS、Git，采用系统安装范围并由官方安装程序配置持久化 PATH；已安装版本会保留。需要管理员权限时由 Windows 请求授权，安装进度与失败原因显示在页面中，完成后重新检测确认命令可用。Halo 会刷新自身 PATH，已打开的外部终端需重新打开；Pi 配置和数据仍共享。自动安装需要 [Microsoft 应用安装程序（WinGet）](https://learn.microsoft.com/windows/package-manager/winget/)，缺少时页面会提供安装说明。

> 网络配置：开发版和安装版 EXE 都在主进程启动时读取 `HTTP_PROXY`、`HTTPS_PROXY`（也支持小写），地址和端口来自环境变量。`ALL_PROXY` 用于未单独配置协议时的回退，`NO_PROXY` 指定直连地址。登录、令牌刷新、模型请求、额度查询和生图共用此配置。Windows 的 `setx` 只影响后续进程，设置后需完全退出应用，并从已获得新环境变量的终端或桌面会话启动；无需另外设置 `NODE_USE_ENV_PROXY`。这与代理工具的 Windows 系统代理开关不同。pi 的传输策略可通过 `~/.pi/agent/settings.json` 的 `transport`（`sse` / `websocket` / `auto`）调整。

> 平台说明：当前以 Windows 为主平台（内置终端依赖 cmd.exe / GBK / taskkill）；macOS / Linux 可启动但内置终端与部分路径逻辑未适配。

### 视频模型

在「设置 → 视频模型」保存 MiniMax API Key，选择默认分辨率、时长和比例；「测试连接」只查询任务列表，不创建收费的视频任务。初期接入 [MiniMax H3 V2](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)，支持文字生成和本地图片首帧生成，默认 768P、5 秒、16:9，可选 2K 和 4–15 秒。

对话中要求生成视频时，Pi 可调用 `video_generate`，结果下载到当前项目的 `output/`，在对话和预览区播放。任务 ID 保存在 `~/.pi/agent/halo-video-jobs.json`，停止等待不会取消云端生成；需要恢复时让助手查询已有视频任务（`list` / `status`），避免重复提交。Key 使用系统加密，存于 `~/.pi/agent/halo-video.json`，不返回给模型或界面；复制配置到另一台电脑后需要重新填写 Key。

平台参数与 HTTP 实现位于 `src/main/video-providers.mjs`；增加其他平台时扩展注册表与适配器。离线验证：`node test/verify-video-generation.mjs`、`node test/e2e/e2e-video-settings.mjs`。这些检查使用模拟服务和本地测试视频，真实 H3 出片需要有效 Key 与平台额度。

## 安全与配置

- **沙箱与 CSP**：渲染层 `sandbox: true` + Content-Security-Policy（仅本地脚本、`halo-preview:` 框架/图片、`data:` 图片），外链只放行 `https://`。
- **命令注入防护**：`pi install/remove/update` 的包源参数经严格白名单校验（无空格/无 shell 元字符），且不再经 `shell: true` 执行。
- **凭据加密**：多账户保管库 `~/.pi/agent/halo-accounts.json` 的令牌通过 Electron `safeStorage`（Windows DPAPI / macOS Keychain）加密落盘；不可用时自动回退明文（与 auth.json 同级）。
- **环境变量**：`HALO_AUTOCLAW_APP_ID` / `HALO_AUTOCLAW_APP_KEY` 可覆盖 AutoClaw 控制台签名密钥（也支持在设置里写 `autoclawAppId/autoclawAppKey`）；`halo.toasts=all`（localStorage）可恢复全部操作提示（错误/警告提示默认始终显示）。

## 测试

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
- 截图输出到 `test/shot-*.png`，测试日志输出到 `test/results/`；这些可再生成的文件不纳入版本管理。CI（GitHub Actions）自动跑 check + lint + 注入脚本验证。

## 项目目录

- `src/`：主进程、预加载桥接与界面代码。
- `assets/`：运行所需的图标、主题、技能与文档示例。
- `scripts/`：启动、构建、检查工具。
- `test/`：回归测试与调试工具，保留测试代码，不提交运行截图和日志。
- `docs/reports/`：历史审查与验证记录，见 [文档索引](docs/README.md)。
- `node_modules/`：本地安装的依赖；`dist/` 为打包输出，`tmp/` 为临时工作目录，均不纳入版本管理。

旧打包输出可以在下次构建前清理。打包验证依赖 `dist/win-unpacked/`，请先运行 `npm run dist:dir` 再执行对应验证脚本。

## 打包

```bash
npm run dist       # 产出 NSIS 安装器（dist/Pi Halo Setup 1.0.0.exe）
npm run dist:dir   # 仅产出免安装目录（dist/win-unpacked/），快速验证
```

打包时会携带锁文件固定的 Pi SDK 与生产依赖。依赖树放在 `resources/app.asar.unpacked/node_modules`，供 SDK、原生模块、图片 Worker 和内置 Pi CLI 共同使用；新电脑无需安装全局 Pi。开发调试仍可通过 `PI_HALO_PI_PATH` 显式指定 SDK 入口。安装额外的 npm/Git 来源插件时，仍需要相应的 npm/Git 工具；这些不影响内核启动和普通对话。

## 快捷键

### 项目终端

预览栏右上角的终端按钮可打开或隐藏控制台。每个项目支持最多 8 个独立 CMD 终端，所有项目合计最多 24 个；通过「＋」新建、标签切换、「◫」平铺多个终端。隐藏控制台或切换项目时进程继续运行，标签上的「×」会结束该终端及其子进程。退出应用后终端不保留。

终端使用 Windows ConPTY，支持方向键编辑、命令历史、Tab 补全和 Ctrl+C 中断。Ctrl+Shift+C 复制选中内容，Ctrl+Shift+V 粘贴；输入 `cls` 清屏。输出采用批量传输和背压控制，回滚历史限制为 5000 行。

运行 `npm run test:terminals` 可验证多终端隔离、分屏、隐藏恢复、大量输出和 Ctrl+C。

| 按键                                             | 作用                                        |
| ---------------------------------------------- | ----------------------------------------- |
| `Enter`                                        | 发送 / 运行中插入引导（steer）                       |
| `Alt+Enter`                                    | 排队追加（follow-up）                           |
| `Shift+Enter`                                  | 换行                                        |
| `Esc`                                          | 中止当前任务 / 关闭弹层                             |
| `/new` `/model` `/thinking` `/compact` `/help` | 内置命令；其余 `/` 命令与 `/skill:name` 由 pi 引擎原生处理 |
| 拖拽 / 粘贴图片                                      | 附加到输入框                                    |

## 架构

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

无打包步骤、无 UI 框架 —— 主进程与 pi 同进程直连（SDK 模式），事件零拷贝转发。

### Windows 原生模块与打包验证

Windows x64 包使用 node-pty 自带的 Node-API 预编译模块（保留 asarUnpack），关闭 electron-builder 的重复编译，避免 SSH 可选 CPU 检测模块要求本机安装 Visual Studio。升级原生依赖后应重新验证打包产物：

```powershell
npm run dist:dir
$env:HALO_TEST_EXECUTABLE = "dist/win-unpacked/Pi Halo.exe"
node test/e2e/e2e-terminals.mjs
Remove-Item Env:HALO_TEST_EXECUTABLE
```

## 内置办公文档技能

应用启动后自动向每个 AI 会话加载 `halo-word`、`halo-excel`、`halo-powerpoint`、`halo-pdf`。使用自然语言提出文档任务即可；通过 `office_document` 工具执行本地脚本、检查产物或渲染 PDF，无需安装系统 Node/Python 或 Microsoft Office。

- 文档技能：`assets/skills/`；共享流程包含环境、单位、数据核验和视觉检查要求。
- 可运行示例：`assets/office-examples/`；正式任务应复制并改成真实内容。
- 工具支持 `status` / `run` / `inspect` / `render_pdf`。run 在单独进程中执行，有超时和取消，权限等同本地 bash，不是沙箱。
- Word 使用 docx，Excel 使用 ExcelJS，PPT 使用 PptxGenJS，PDF 使用 PDFKit/pdf-lib，PDF 页面渲染使用 Mozilla PDF.js 与 @napi-rs/canvas；依赖随应用打包。
- 中文 PDF 优先使用 Windows 黑体，可用 `HALO_DOCUMENT_FONT` 指定自己的中文 TTF。字体不随项目重分发。
- XLSX 公式并非由 ExcelJS 重算；检查会报告缺失缓存和错误，技能要求独立校验关键数字。有 Office/LibreOffice 时可进一步重算与渲染。Word/PPT 原生版式视觉检查需要已有 Office/LibreOffice；本项目不把结构检查假称为视觉检查。
- 保留第三方包自带许可证。当前 PptxGenJS 的传递 image-size 依赖有未发布修复的解析器公告，文档 worker 已限制到 PNG/JPEG/GIF/SVG/WebP/BMP，禁用 ICNS/JXL/HEIF 等复杂类型；仍应跟踪上游更新。ExcelJS 的 uuid 依赖已覆盖到修复版本 11.1.1。

验证：`node test/verify-office.mjs`、`node test/verify-office-runtime.mjs`；构建后 `node test/e2e/verify-office-packaged.mjs` 验证打包内四种生成与 PDF 渲染。

### 内置文件预览

点击文件树中的 PDF、DOCX、XLSX、PPTX 可直接在中间区域只读预览，不上传文件。PDF 支持翻页；Excel 支持工作表切换，展示缓存公式结果（不计算公式），上限 2000 行 / 100 列；Word 使用 HTML 版式；PPT 使用本地渲染库，无法解析时退回基础 OOXML 文字、图片与布局预览。复杂 Office 图表、动画、母版及特殊排版不保证与 Office 完全一致。旧 DOC、XLS、PPT 需先转换成现代格式，文件大小上限 64 MB。

预览依赖存放在 `src/renderer/vendor/office`，使用 `node scripts/build-office-viewer.mjs` 重建；附带依赖许可证。运行 `node test/e2e/e2e-office-preview.mjs` 会生成四种样例并在 Electron 中验证。
