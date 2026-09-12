---
name: halo-word
description: 编写和修改可编辑 Word DOCX 文档，包括报告、方案、合同草稿、规范与含表格图片的文档。使用内置 docx 工具、样式与结构检查，不依赖安装 Word。
---

# Word 文档

新建或美化时应用 [文档视觉设计标准](../document-design.md)。

先读 [共享工作流](../office-workflow.md)。status 返回的 examples/word.cjs 是可运行起点，使用 `office.docx` 完整 API，不受演示模板限制。

## 编写

先明确受众、文档目的、数据来源和篇幅。用户有模板时优先保留模板布局；没有模板可使用 A4、约 2 cm 页边距、中文正文字体 10.5–11pt、统一标题层级。正文内容与用户要求匹配，不填虚构事实。

使用 Document、Paragraph、TextRun、HeadingLevel、Table/TableRow/TableCell、Header/Footer、PageNumber 和 ImageRun 等原生对象。使用标题样式而非仅加粗正文；数字编号使用 numbering 定义，避免以手工数字冒充自动编号。表格总宽度不得超过版心；长表设置重复表头并避免一行跨页；图片保持比例。页码使用字段，目录用 TableOfContents，需要在 Word/转换器更新字段后复查。

docx 的 size 是半磅，页面和缩进一般是 twip，图片 transformation 为像素；不要混用单位。模板按品牌调整字体/字号/色彩，不把每段都装进文本框。

## 编辑

对现有 DOCX 先用 inspect 检查并阅读文本摘要，必要时用 JSZip 解包读取 word/document.xml、styles.xml、numbering.xml 和关系文件。docx 不是通用的 DOCX 读取再无损保存器。简单占位符替换可查阅内置 docx 的 patchDocument；复杂保留样式编辑使用 XML 解析而非盲目字符串替换，保留编号、书签、关系、图片和内容类型。修订/批注需要正确的 OOXML 作者、ID 和范围，不能通过红字假装真实修订。超出已验证范围时如实说明。

## 交付检查

原生 DOCX 必须 inspect 成功。核对标题层级、页边距、表格、页码及实际文本。可用原生转换器时导出 PDF 再视觉检查每页；无转换器不要声称分页已经验证。

官方 API：https://docx.js.org/api/ 。示例入口为 examples/word.cjs。
