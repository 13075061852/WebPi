# 项目排查记录（进行中）

日期：2026-09-11。用户授权全面分析、修复、测试与性能优化；保留现有未提交功能和业务数据。不将阶段测试通过等同于整体完成。

## 已修复并验证

- SSH 并发连接：`ServerManager.connect` 共享同一进行中请求，6 个并发命令只建立一条 SSH 连接。删除、编辑、退出时取消未完成连接，防止服务器删除后连接复活；握手提前关闭也会结束等待。
- 文件预览异步竞态：Markdown、HTML 源码、普通文本读取结束后校验当前预览请求；旧文件不再覆盖新文件；重复点击同一文件不会取消其读取。
- 思考流式性能：同帧 delta 合并一次 Markdown 渲染与滚动布局读取。测试 100 个 delta 只渲染一次，阶段结束强制刷新末尾文本。

## 本轮已执行验证

- `npm run check`：109 个文件通过；`npm run lint` 通过。
- `test/verify-*.mjs` 原有 11 项：项目/服务器会话分组、删除、历史绑定、延迟、监听端口、HTTP SSH 预览、系统提示上下文、SSH 工具注册、真实本地 SSH 认证执行通过。
- 修改后的 `test/verify-servers.mjs`：新增并发与取消用例通过。
- 新增 `test/verify-preview-races.mjs`、`test/verify-thinking-batch.mjs` 通过。
- Electron `e2e-message-input`：文本/图片输入、图片预览及发送按钮通过。
- Electron `e2e-session-restore`：运行中工具、闲置切换、恢复、部分续写、完成通过；思考批处理改动后重跑通过。
- Electron `e2e-terminals`：独立 shell、输入输出、平铺、隐藏恢复、关闭隔离通过；18,000 行输出排空，Ctrl+C 后 shell 环境保留。
- Electron `e2e-render`：消息、工具、错误与明暗文档渲染通过，控制台无错误。
- `verify-stream-render` 与触摸注入脚本语法检查通过。

## 待继续检查（不是已完成）

- 服务器预览 listener 生命周期、关闭中的异步探测和资源释放；命令取消/错误的 timer、listener 清理。
- 项目切换、删除与并发消息的状态一致性；后台任务隔离。
- 文件访问边界、IPC 来源、预览导航与本地服务隔离。
- 主题透明度和卡片尺寸的长期回归覆盖；设备切换/触摸真实行为与性能。
- 启动、长会话/大文件性能测量；构建/打包可用性。
- 最终统一回归与实际启动检查，再据证据完成审计。

当前额度已用 86%，尚未触发剩余 1% 的重置条件；用户已授权届时使用一张重置卡，可用 2 张。

## 第二轮进展

- 远程命令统一完成/失败/取消清理，取消不再被同步 close 事件抢先判为成功；等待通道返回时取消会关闭迟到通道。StringDecoder 保证分包中文/表情完整，超限当包即标记截断。
- 新增 `verify-server-exec.mjs`，覆盖 UTF-8、截断、取消同步关闭、迟到通道、错误清理，已通过；本地真实 SSH 测试重跑通过。
- 预览请求按规范化地址和端口合并，探测阶段可断开取消，关闭移除 close 监听和全部探测 socket，防止关闭后写回缓存。
- 新增 `verify-preview-cleanup.mjs`，使用不应答的模拟通道覆盖中途断开、重复请求、隧道销毁，已通过；原 HTTP 预览回归通过。
- IPC handler 加入调用窗口、主 frame、准确本地文档 URL 校验；窗口控制事件同样校验。需要继续补充拒绝路径自动化和全界面回归。
- 最近 check/lint 通过（111 个文件）。剩余审计范围仍按上方列表继续，未宣告整体完成。

## 第三轮进展

- `verify-ipc-sender.mjs` 覆盖正常主窗口/启动页，以及外部窗口、子 frame、空 frame、跳转后 URL、已销毁窗口的拒绝路径，通过。
- `npm run dist:dir` 首次失败于可选 cpu-features 重编译需要 Visual Studio。检查 node-pty 提供的 Windows x64 Node-API 预编译模块后，设置 build.npmRebuild=false，构建通过。
- 使用实际 `dist/win-unpacked/Pi Halo.exe` 跑完整终端 E2E，通过 18,000 行、Ctrl+C、分屏、恢复、关闭隔离。已将 HALO_TEST_EXECUTABLE 支持加入正式终端测试，并在 README 记录重跑命令。
- 主题 E2E 新增统一缩略图大小、工具栏透明度 0/50/100 三档变化、70% 重启保存验证，全部通过。
- 新增 workspace-path.mjs 校验项目词法路径和 realpath，拒绝 junction/symlink 跨出项目；修复 Windows 根目录删除校验大小写问题。verify-workspace-path.mjs 全部通过。
- 新增 read-preview-file.mjs，将主进程预览读取改为异步限量读取，finally 关闭文件，截断 UTF-8 不输出半个字符。verify-preview-file.mjs 覆盖 20 个并发大文件、二进制、空文件、目录和 Unicode 边界，通过。
- 最近 check/lint 通过（116 个文件）。打包产物是在新增 workspace-path/read-preview-file 之前构建，最终需重建再验证，不可当作最新版本完成证据。

## 第四轮进展

- 新增 e2e-device-touch：电脑/平板/手机反复切换后 iframe 矩形与 innerWidth 一致，聊天区域 >= 480px；真实注入脚本模拟拖动滚动 200px，圆点光标有效；关闭触摸后清理状态，通过。
- 修复手机底部横条样式没有在关闭触摸时移除的问题，改为带 ID 的样式并用媒体查询适配宽度，测试覆盖。
- 长历史测量：200 轮/400 消息，每条回复 12 段 Markdown。初始 7729ms、最大帧间隔 848ms；禁止恢复期间逐条读取滚动布局，只在完成后滚到底部，降至 570ms、48ms。新增 e2e-history-performance 保留完整性和响应时间阈值回归。
- 恢复历史时克隆 messages 数组，防止附加 partial 修改调用方快照。会话恢复 E2E 重跑通过。
- 新增 npm run test:audit，顺序跑根目录所有 verify、流式/触摸校验和 7 项真实 Electron E2E，记录 test/results/audit.json 与逐项日志；下一轮执行统一回归并复核未覆盖状态路径。

## 最终审计结果

最终最新代码统一回归 28/28 通过，check 120 文件与 lint 通过，生产依赖已知漏洞查询 0，git diff --check 通过。最新 Windows 免安装构建成功；随后用该产物再次跑正式终端 E2E，18,000 行、Ctrl+C、分屏与关闭隔离均通过。完整范围、实测数字、修复映射及外部环境限制见 AUDIT-REPORT.md。上方“待继续检查”为早期阶段清单，以本节和最终报告为准。
