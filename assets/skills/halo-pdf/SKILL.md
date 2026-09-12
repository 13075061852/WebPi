---
name: halo-pdf
description: 创建、读取、合并、拆分和检查 PDF 文件，支持中文字体、页面渲染与文字提取。使用内置 PDFKit、pdf-lib 和 PDF.js，无需安装 PDF 编辑器。
---

# PDF 文档

新建或美化时应用 [文档视觉设计标准](../document-design.md)。

先读 [共享工作流](../office-workflow.md)。读取 examples/pdf.cjs；创建用 office.PDFKit，修改/合并/拆分页用 office.PDFLib，真实页面渲染和文字提取用 render_pdf。

## 创建

PDF 是最终版面格式。需要同时提供可编辑源时输出 DOCX/XLSX/PPTX，不能仅交 PDF。明确纸张大小、页边距、标题层级和正文密度。PDFKit 的坐标为 pt，A4 约 595×842pt。

中文必须嵌入支持中文的字体（status 的 font，或 HALO_DOCUMENT_FONT），不能默认 Helvetica。确保字体授权适用于用户用途。段落允许自然换页；标题与其后内容避免孤立；页眉页脚不得侵占正文。表格手动布局应预先测量文本高度和分页，长文本列不能固定过小行高。

完成时 await 写入 stream 的 finish 后再返回 files，不能只调用 doc.end() 就交付。

## 读取与修改

inspect 验证页数。render_pdf 实际渲染并提取选定页面文本；扫描件无文字时不能据此声称 PDF 为空，需要 OCR 才能读取，不要编造 OCR 结果。加密文档要求合法密码/可读副本。

pdf-lib 支持 load、copyPages、addPage、removePage、旋转、表单和叠加。合并保留原页面尺寸/方向；抽页使用零基页索引，小心用户的一基页码。修改另存新文件。加盖白色矩形不是真正信息脱敏；不能把遮挡当成安全删除原文。数字签名与复杂交互表单可能受修改影响，明确告知。

## 视觉检查

运行 render_pdf，read 打开返回的 PNG，检查每页缺字、裁切、遮挡、页码、空白和分辨率。默认只渲染前 12 页，需覆盖所有交付页时调整 maxPages；超 50 页通过 startPage 参数分批，不声称未看过的页已检查。最终交付 PDF 本身，不拿图片代替 PDF。

官方文档：https://pdfkit.org/docs/getting_started.html 和 https://pdf-lib.js.org/ 。示例：examples/pdf.cjs。
