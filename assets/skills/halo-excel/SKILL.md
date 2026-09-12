---
name: halo-excel
description: 创建、读取和修改 Excel XLSX 工作簿，包含公式、预算、数据分析、表格、筛选、冻结、验证和打印设置。使用内置 ExcelJS 并检查公式缓存与数据一致性。
---

# Excel 工作簿

新建或美化时应用 [文档视觉设计标准](../document-design.md)。

先读 [共享工作流](../office-workflow.md)。读取 examples/excel.cjs，用 office.ExcelJS 编写脚本。用户要求 Excel 时交付真正的 XLSX，不将 CSV 重命名。

## 数据与公式

数值存为 number、日期存为 Date，并设置 numFmt；不要把数值和货币符号拼成字符串。所有计算应尽量保留可编辑公式，以便输入变动后重新计算。原始数据、假设与输出分开，标注单位、来源及时间范围；不得补造来源数据。

ExcelJS 不计算公式。使用 `{formula:"SUM(D3:D5)",result:15400}` 时，result 必须独立算出且与公式一致，不可填占位 0。设置 fullCalcOnLoad=true 只请求 Excel 重算，并不代表本机已经重算。交付前用 JS 独立验证总计、分组、百分比和关键边界值；有 LibreOffice/Excel 则另存副本重算并重新读回检查。inspect 的 formulaWarnings 不应忽略。

读取 `await workbook.xlsx.readFile(path)` 后先检查 sheet 名称、维度、合并、格式和公式。修改保留原有结构，另存输出。不要在用户表格里写内部脚本路径、调试日志或编写指令。

## 易读性

合理列宽、冻结表头、自动筛选、统一数值格式、条件格式和数据验证。输入/计算区域可有轻量区分。不要全表合并单元格；合并仅用于必要标题。打印区与横纵向按实际内容设置，宽度一页、高度自动，避免缩成不可读的小字。

ExcelJS 对现有宏、切片器、透视表、复杂图表等功能不保证保真；遇到 XLSM 或复杂模板先确认保留要求，不做无损保证。ExcelJS 不是原生图表生成器；需原生复杂图表时使用适合的引擎或保留模板，不能把图片称作可编辑 Excel 图表。

## 检查

inspect 验证 XML、工作表维度、公式缓存和错误值；脚本独立断言行数、总计及关键计算结果。抽查空值、零值、负数、日期和大额数据。不在未经计算时声称公式已验证。

官方文档：https://github.com/exceljs/exceljs 。示例：examples/excel.cjs。
