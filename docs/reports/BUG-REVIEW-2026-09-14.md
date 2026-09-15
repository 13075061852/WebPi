# Pi Halo 项目用途与潜在 BUG 排查

日期：2026-09-14。审查基线：Git `c644689`，Node.js `v24.20.0`。下方排查记录保留修复前的触发条件和代码行号。

**修复结果（2026-09-14）**

下列 9 项功能问题均已修复，两项失效测试已恢复。源码改动尚未提交 Git，也未生成或安装新的 EXE。

- 删除当前会话优先留在同一项目或服务器；删除最后一个服务器会话会回到当前本地项目，目录与实际工具上下文一致。
- 目录选择只返回路径，添加和恢复项目都经过切换队列，等待启动完成并保留后台任务；界面同时丢弃过期的项目切换回调。
- 发送失败仅恢复原会话中未被修改的草稿，不覆盖新的文字/附件，也不改变其他任务的运行状态。
- 账户切换先在凭据锁内保存最新身份，再读取目标账户；刷新、切换和额度查询按供应商串行，迟到结果不会覆盖新账户额度，排队登录也可以取消。
- 无稳定 `accountId` 的 OAuth 新凭据独立归档，不依据旧 activeId 猜测合并；选择旧副本前必须刷新验证，失败保持当前登录。已失效的历史条目不会被自动修复为有效令牌，可选择保留的新条目或重新登录。
- token/费用只按 `message_end` 累计，实时统计与历史重算一致。
- 普通发送、重试、引导和追加均按实际用户消息事件展示，重复文本仍分别显示，技能文本和图片与历史恢复一致。
- Markdown 使用读取结果返回的实际绝对路径解析相对图片及链接。
- 文档子进程使用流式 UTF-8 解码，并仅在行首匹配结构化结果标记。

新增离线回归入口 `npm run test:regressions`，已加入 CI。最终验证：

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 166 个文件，0 个失败 |
| `npm run lint` | 通过 |
| `npm run test:regressions` | 21/21 通过，含会话、账户、消息、文档及原有边界测试 |
| `test/e2e/e2e-message-input.mjs` | Electron 真实 DOM：历史/实时文字图片、相同追问分别展示、回答轮次分隔、发送按钮通过 |
| `test/e2e/e2e-session-restore.mjs` | 活跃工具、空闲切换、流式片段续接和完成状态通过 |
| `test/e2e/e2e-render.mjs` | 流式回答、工具、队列、错误展示、明暗主题与 Markdown 布局通过，未发现控制台错误 |
| 文档协议回归在 Electron `ELECTRON_RUN_AS_NODE=1` 下运行 | 通过 |
| `git diff --check` | 通过 |

离线测试使用隔离的 SDK/账户夹具；GUI 测试使用临时 Electron userData 和 SDK 配置，注入模拟模型事件，没有发起真实模型推理或操作线上服务器。未执行安装包构建、真实供应商 OAuth 登录或原生 Microsoft Office 转换验证。可重复测试结果位于 `test/results/regressions.json` 和 `test/results/gui-fixes.json`（可再生成，未纳入 Git）。

**项目用途**

WebPi 仓库中的产品名为 Pi Halo（星环），是以 Windows 为主要运行平台的 Electron AI 编程助手桌面客户端。它通过全局安装的 pi SDK 驱动模型与工具执行，并与 pi CLI 共享模型配置、认证及技能资源。

- AI 对话：流式回答、思考与工具执行展示，多会话并发、历史恢复、引导与追加消息。
- 项目工作区：项目切换、文件树、改动与 Diff 展示、网页/图片/Markdown/Office 文件预览。
- 本地与远程操作：项目终端、SSH 服务器、远程命令、监听端口与网页预览。
- 扩展能力：多账户与额度显示、插件/技能管理、图片及 Word/Excel/PPT/PDF 生成。

主要调用链是原生 HTML/CSS/JS 界面 → preload 暴露的受控 IPC → Electron 主进程 → pi SDK、终端、SSH 和文档子进程。入口为 `src/main/main.mjs`，会话核心在 `src/main/pi-bridge.mjs`，主要交互在 `src/renderer/js/app.js`。

**排查结论**

确认 9 项功能缺陷，另发现 2 个现有测试脚本失效。P1 表示应优先修复的数据/任务正确性问题，P2 表示普通功能缺陷。以下复现采用临时目录、模拟 SDK/事件或抽取源码函数执行；涉及 SSH 的既有测试使用本机回环服务。没有连接实际业务服务器或发起付费模型请求，也未执行完整应用 GUI 回归。

| 编号 | 级别 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| 1 | P1 | 删除当前会话后，界面项目与实际 AI 工作目录可能不一致 | [pi-bridge.mjs:1645](C:/Users/32911/Desktop/GitHub/WebPi/src/main/pi-bridge.mjs:1645) |
| 2 | P1 | 从“添加项目”选择新目录会停止其他运行中的会话 | [main.mjs:550](C:/Users/32911/Desktop/GitHub/WebPi/src/main/main.mjs:550) |
| 3 | P1 | 旧会话发送失败会覆盖当前会话草稿、附件和运行状态 | [app.js:1364](C:/Users/32911/Desktop/GitHub/WebPi/src/renderer/js/app.js:1364) |
| 4 | P2 | 账户切换会用旧副本覆盖 SDK 已刷新的 OAuth 凭据 | [pi-bridge.mjs:1032](C:/Users/32911/Desktop/GitHub/WebPi/src/main/pi-bridge.mjs:1032) |
| 5 | P2 | 同一条回答的 token 与费用被重复累计 | [pi-bridge.mjs:799](C:/Users/32911/Desktop/GitHub/WebPi/src/main/pi-bridge.mjs:799) |
| 6 | P2 | 执行期间追加的用户消息不进入实时聊天记录 | [app.js:949](C:/Users/32911/Desktop/GitHub/WebPi/src/renderer/js/app.js:949) |
| 7 | P2 | 子目录 Markdown 的相对图片和链接解析到错误目录 | [app.js:2394](C:/Users/32911/Desktop/GitHub/WebPi/src/renderer/js/app.js:2394) |
| 8 | P2 | 文档子进程跨数据块的中文回传可能乱码 | [tools.mjs:18](C:/Users/32911/Desktop/GitHub/WebPi/src/main/office/tools.mjs:18) |
| 9 | P2 | 文档内容与结果标记同名时，合法文档检查/预览失败 | [tools.mjs:22](C:/Users/32911/Desktop/GitHub/WebPi/src/main/office/tools.mjs:22) |

**1. 删除会话后操作目标项目错误**

触发：项目 A、B 都有驻留会话，当前在 B，删除 B 当前会话。`deleteSession()` 从整个会话池中挑选最近使用的 A，然后直接 `#focus(next)`；`#focus()` 只更新会话引用，没有同步 `this.cwd`。随后 `_noteSession()` 又把 A 的记录路径写入 B 的 `lastSession`。

临时 SDK fixture 复现得到：界面 `reportedCwd=project-b`，实际会话文件为 `fixture_A.jsonl`，B 的 `lastSession` 也变为 A 的文件。文件树及界面显示 B，实际 agent 仍按 A 的上下文执行，存在修改错误项目的风险。

建议：复用完整会话切换流程，原子更新会话、项目目录和持久化引用；或优先留在原项目创建新会话。回归必须覆盖跨项目和服务器会话的删除回退。

**2. 添加项目会中止后台任务**

触发：A 正在执行，点击项目添加按钮，选择 B 目录。界面 `pickProject()` 调用主进程 `halo:pick-project`，其直接执行 `bridge.start(dir)`。`_doStart()` 通过 `#resetPool()` 释放所有会话，而正常 `switchProject()` 会保留运行中的会话。

直接抽取实际 IPC handler 并用临时 SDK fixture 执行，A 标记为运行中，选择 B 后得到 `disposedSessions=["A"]`。本机 SDK 的 runtime/session 释放实现会调用 `agent.abort()`，因此实际任务会被停止；受影响的不只当前会话，也包含其他后台会话。

建议：目录选择只返回所选路径，将添加与切换统一交给保留会话池的项目切换队列。增加“运行中添加新项目，原任务继续执行”的回归。

**3. 发送失败回滚覆盖其他会话草稿**

触发：A 发送后等待返回；切到 B 输入草稿、附加图片或启动任务；A 的请求随后失败。`send()` 的 catch 无条件写回输入框、`S.images` 并调用 `setStreamingUI(false)`，没有检查发送时的会话或输入版本。

VM 直接执行源码后得到：当前 `session=B`，但 `draft=A 原始请求`、`attachments=A.png`、`streaming=false`。主进程等待整轮 `session.prompt()` 才返回，竞争窗口可以持续整个任务。

建议：把失败信息与待恢复草稿绑定到原会话；只有会话和输入版本仍匹配时才回填，不能覆盖用户后来输入的内容，也不能修改另一个任务的运行状态。

**4. OAuth 刷新后的凭据被旧账户副本覆盖**

触发：保存账户 A 后，SDK 自动刷新 A 的 access/refresh token；账户保管库仍保存 A 的旧副本；切到 B，再切回 A。`authAccountSwitch()` 直接把目标保管库条目写回认证存储，没有先保存当前账户的最新凭据。`authProviders()` 也只补充元数据，不同步凭据。

临时认证 fixture 确认：切回 A 后实际 refresh token 恢复为 `A-refresh-old`，已刷新的副本被覆盖。对轮换后废弃旧 refresh token 的供应商，可能导致重新登录；本次确认的是旧值覆盖，未调用外部 OAuth 服务验证各供应商失效策略。

建议：切换前按稳定账户身份捕获当前最新凭据；目标账户写入前处理过期与刷新，并避免并发刷新覆盖新版本。

**5. 用量和费用重复统计**

`_accountUsage()` 同时累计 `message_end` 和 `turn_end` 中的 usage。本机 SDK 在这两个事件中传递同一条 assistant 消息，因而同一用量计入两次。

本地复现：单次 usage 为 input=100、output=20、cost=0.1，处理两个事件后变为 200、40、0.2。切走再切回时，历史重算只按 assistant 消息累计一次，所以显示还会跳回原值。这里影响的是客户端统计展示，不表示供应商实际重复收费。

建议：选择唯一权威事件记账，或按消息标识去重，验证实时统计与历史重算一致。

**6. 追加的用户消息在实时界面消失**

执行中发送走 `steer()` 分支，只入队并清空输入框，没有调用 `renderUserMsg()`；消费队列时的 `user message_start` 又被 `onMessageStart()` 直接忽略。`followUp` 分支同样存在该缺口。

VM 复现确认 steer 收到文本，但用户消息渲染次数为 0。队列消费后，实时界面不再显示这条追问；重新恢复会话历史时才会出现。消息已送入后端，问题在实时展示及轮次分隔。

建议：统一处理实际用户消息事件，并与普通发送的乐观渲染去重；覆盖 Enter、按钮发送及 Alt+Enter。

**7. Markdown 相对资源基准目录错误**

文件预览调用 `rich(content)`，后者固定以项目根目录下的虚拟 `__chat__.md` 为基准。预览 `C:/project/docs/README.md` 中的 `![diagram](./images/diagram.png)`，实际生成 `C:/project/images/diagram.png`，正确目标应为 `C:/project/docs/images/diagram.png`。

建议：文件预览使用 `mdRender(content, p)`，将实际 Markdown 文件路径传给已经支持基准路径的渲染器。添加子目录图片和相对链接回归。

**8. 文档回传的 UTF-8 跨块解码损坏**

文档 worker 的 stdout 处理使用 `stdout += data`，逐个 Buffer 隐式解码。当一个汉字的 UTF-8 字节跨两个数据块时，字符变成替换符；stderr 同类处理也存在此问题。

本地 builder 返回 400000 个“中”，实收长度为 400018，包含 30 个 `U+FFFD`。影响结果、检查摘要、日志等返回文本；不会直接损坏脚本已经写出的文档本体。

建议：stdout/stderr 使用流式 UTF-8 解码，例如 `setEncoding('utf8')` 或 `StringDecoder`。

**9. 文档正文被误认为结果协议头**

worker 输出 JSON 前缀为 `HALO_OFFICE_RESULT=`，父进程用 `lastIndexOf(marker)` 定位。若 JSON 内的文档正文也含该字符串，定位会落在正文内部，随后 JSON 解析失败。

使用 docx 库创建 8562 字节的有效 DOCX，唯一段落是“文档内容含有 HALO_OFFICE_RESULT= 标记。”。`runOffice({action:'inspect'})` 与 `previewDocument()` 均报 `Unexpected token '标'`。同样影响包含此标记的其他结构化结果。

建议：使用独立结构化 IPC 通道，或严格匹配真实结果帧的行边界，避免从任意正文搜索分隔符。

**修复前验证记录**

- `npm run check`：158 个文件，0 个失败。
- `npm run lint`：通过。
- 运行 19 个现有测试脚本：17 个通过，2 个失败。下表是本次实际运行记录，不等于完整 `test:audit` 或 GUI 套件全部通过。

| 结果 | 脚本 |
| --- | --- |
| 通过 | `test/verify-preview-races.mjs` |
| 通过 | `test/verify-preview-refresh.mjs` |
| 通过 | `test/verify-preview-file.mjs` |
| 通过 | `test/verify-preview-inspection.mjs` |
| 通过 | `test/verify-workspace-path.mjs` |
| 通过 | `test/verify-trusted-ui-url.mjs` |
| 通过 | `test/verify-thinking-batch.mjs` |
| 通过 | `test/verify-user-message.mjs` |
| 通过 | `test/check-touch-script.mjs` |
| 通过 | `test/verify-servers.mjs` |
| 通过 | `test/verify-server-preview.mjs` |
| 通过 | `test/verify-server-latency.mjs` |
| 通过 | `test/verify-server-ports.mjs` |
| 通过 | `test/verify-preview-cleanup.mjs` |
| 通过 | `test/verify-server-exec.mjs` |
| 通过 | `test/verify-office-failures.mjs` |
| 通过 | `test/verify-image-generation.mjs` |
| 失败 | `test/verify-ipc-sender.mjs`：`ReferenceError: isTrustedUIURL is not defined` |
| 失败 | `test/e2e/verify-stream-render.mjs`：`ReferenceError: document is not defined` |

第一项失败是 VM 未注入主进程新增的 `isTrustedUIURL` 依赖；第二项是测试仍按无 DOM 环境执行，但 `rich()` 已读取 `document.documentElement.dataset.projectCwd`。这两个错误证明测试脚本需要更新，不等同于应用中的 IPC 验证或浏览器渲染本身必然报同样错误。`test:audit` 遇到非零退出会提前停止；CI 当前主要跑语法、lint 和注入语法检查，不能覆盖以上运行时缺陷。

原排查建议优先修复 1–3，再处理认证、统计、预览和消息展示。当前完成情况及验证边界见本报告开头的修复结果。
