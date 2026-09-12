# Office 链路验证（2026-09-12）

## 已通过
- 原生生成：DOCX、XLSX、PPTX、PDF。
- Microsoft Office 转换：Word SaveAs2、Excel ExportAsFixedFormat、PowerPoint SaveAs。
- 开发版完整生成+转换+逐页渲染样例：Word 10.2秒/1页、Excel 4.9秒/1页、PPT 3.4秒/3页、PDF 0.9秒/2页；不是单独模型生成耗时。
- 已人工查看上述7页PNG，中文、表格、图表、页码未见缺字或越界。
- 安装目录 app.asar：四种文件生成、PDF画布渲染、三种原生Office转PDF通过。
- 应用内四种预览通过，PDF底部分页布局通过。
- 同页并发请求合并、重复预览缓存、文件修改后失效、越界页拒绝。
- 执行中和排队取消、取消后工作槽恢复、损坏文档拒绝、禁止覆盖已有PDF。
- 原生转换启动阶段取消测试通过，检查无遗留Word进程。
- 曾实际触发Word导出60秒超时，并确认进程清理；现已更换为成功的SaveAs2导出方式。
- 已运行Office时拒绝转换，保护已有文档。

## 本轮修复
- Word没有Application.HWND属性，改为在确认无既有进程后识别唯一新启动Word进程。
- Word ExportAsFixedFormat在本机卡住，改用验证成功的SaveAs2。
- PowerShell转换脚本先复制到临时目录，解决asar内脚本无法直接执行。
- 取消发生在PID回报前时先等待身份信息；终止后短暂等待进程退出。
- 临时目录创建失败不锁死转换状态；失败记录数量限制128。

## 测试入口
- test/verify-office-native.mjs
- test/verify-office-failures.mjs
- test/verify-office-efficiency.mjs
- test/verify-office-runtime.mjs
- test/verify-office-packaged-convert.mjs
- test/e2e/verify-office-packaged.mjs
- test/e2e/e2e-office-preview.mjs

## 边界
有限样例不能保证任意复杂文档、所有Office版本或加载项均无故障。Office转换仍需要本机安装对应软件且未占用；纯PDF生成不依赖Office。当前仅Windows原生转换。Excel结构检查不代表全部公式已重新计算。复杂PPT的应用内预览不等于Office像素级还原。未安装Office、COM注册损坏和启动超过清理宽限期的系统级故障未进行破坏性模拟。
