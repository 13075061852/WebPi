# 使用指南

[返回项目首页](../README.md) · [全部文档](README.md)

## 开始第一个任务

1. 安装并打开 Pi Halo，在设置中完成所用供应商的登录或 API Key 配置。
2. 添加本地项目文件夹，在该项目下新建对话。
3. 描述任务，或从文件树把文件添加到当前对话；生成的文件可在项目目录和预览区查看。

安装版已包含 Pi 内核和 Electron 的 Node 运行时，普通对话不要求预装全局 Pi 或 Node。任务使用的外部工具按需准备，见 [Windows 环境配置](ENVIRONMENT-SETUP.md)。

## 项目、对话与预览

- 左侧管理项目、对话和文件，右侧显示消息与任务进度，中间预览区按需展开。
- 切换对话不会中止后台任务；执行中的会话需先停止任务再删除。
- 文件树支持打开预览、添加到当前对话及文件操作。预览通过本地 `halo-preview://` 协议读取项目文件。
- 本地网页项目可用项目旁的「启动」入口，详细行为见 [本地项目启动与预览](PROJECT-START.md)。
- 标题栏可切换明暗外观；主题图片见 [主题图片说明](THEME-IMAGES.md)。

## 多账户与额度

登录配置里每个供应商可保存多个登录身份（OAuth 订阅 / API Key 均可）：每次订阅登录成功自动存为一个账户，也可用「存为账户」手动保存当前身份；账户以芯片形式列在供应商下方，**每个芯片实时显示该账户的剩余额度**（订阅制 5h/7d 百分比、余额制金额、积分制分数，登录配置打开时自动拉取），**点击芯片即一键切换使用哪个账户的额度**（写回与 pi CLI 共享的 `~/.pi/agent/auth.json`，切换完成立即拉取新账户额度并同步模型快照，底部额度条与模型列表随之更新）。登出后账户仍保留在保管库中，随时可切回，无需重新走 OAuth。双击芯片可重命名，× 两次确认删除。保管库文件：`~/.pi/agent/halo-accounts.json`（与 auth.json 同目录、同等敏感，请勿外传）。

## 项目终端与快捷键

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

## 办公文档与文件预览

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

点击文件树中的 PDF、DOCX、XLSX、PPTX 可直接在中间区域只读预览，不上传文件。PDF 采用连续滚动阅读，支持选择和复制文字；Excel 支持工作表切换，展示缓存公式结果（不计算公式），上限 2000 行 / 100 列；Word 使用 HTML 版式；PPT 使用本地渲染库，无法解析时退回基础 OOXML 文字、图片与布局预览。复杂 Office 图表、动画、母版及特殊排版不保证与 Office 完全一致。旧 DOC、XLS、PPT 需先转换成现代格式，文件大小上限 64 MB。

预览依赖存放在 `src/renderer/vendor/office`，使用 `node scripts/build-office-viewer.mjs` 重建；附带依赖许可证。运行 `node test/e2e/e2e-office-preview.mjs` 会生成四种样例并在 Electron 中验证。

## 图像、视频与数字人

在设置中配置相应模型后，通过对话提出生成任务。各平台的模型、参数、任务恢复及连接测试说明见 [视频模型](video-providers.md)；声音样本与数字人流程见 [数字人方案](DIGITAL-HUMAN.md)。平台订阅与 API 额度可能不同，以对应账户实际权限为准。

## 网络与环境

优先在应用的网络设置中选择直连或代理，并使用连接测试确认。环境变量也可为启动进程提供代理地址；修改 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 或 `NO_PROXY` 后需完全退出并重新启动应用。Windows 的 `setx` 不会修改已运行进程的环境。

外部 Python、Node.js、Git 的检测、安装与 PATH 修复见 [Windows 环境配置](ENVIRONMENT-SETUP.md)。已安装的可用工具不会因配置流程被重复安装。

## 软件更新

安装版启动后立即检查更新，此后每分钟检查一次。发现新版本会后台下载，左下角显示进度；完成后点击「重启更新」才开始安装。开发模式不自动更新，详见 [软件更新说明](app-updates.md)。

## 安全与配置

- **沙箱与 CSP**：渲染层 `sandbox: true` + Content-Security-Policy（仅本地脚本、`halo-preview:` 框架/图片、`data:` 图片），外链只放行 `https://`。
- **命令注入防护**：`pi install/remove/update` 的包源参数经严格白名单校验（无空格/无 shell 元字符），且不再经 `shell: true` 执行。
- **凭据加密**：多账户保管库 `~/.pi/agent/halo-accounts.json` 的令牌通过 Electron `safeStorage`（Windows DPAPI / macOS Keychain）加密落盘；不可用时自动回退明文（与 auth.json 同级）。
- **环境变量**：`HALO_AUTOCLAW_APP_ID` / `HALO_AUTOCLAW_APP_KEY` 可覆盖 AutoClaw 控制台签名密钥（也支持在设置里写 `autoclawAppId/autoclawAppKey`）；`halo.toasts=all`（localStorage）可恢复全部操作提示（错误/警告提示默认始终显示）。

本地工具和生成脚本具有当前用户的文件与命令执行权限。预览渲染的隔离不等于任务执行沙箱。
