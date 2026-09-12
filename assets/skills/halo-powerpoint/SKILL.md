---
name: halo-powerpoint
description: 创建可编辑 PowerPoint PPTX 演示文稿，包含母版、图表、表格、图片与中文排版。使用内置 PptxGenJS，并检查页数、结构和视觉布局。
---

# PowerPoint 演示文稿

新建或美化时应用 [文档视觉设计标准](../document-design.md)。

先读 [共享工作流](../office-workflow.md)。读取 examples/powerpoint.cjs，用 office.PptxGenJS 编写演示。交付真正 PPTX，文字、形状、图表应保持可编辑。

## 设计流程

按受众组织论点和页级大纲，再选择母版与配色。每页一个主要结论，标题说清内容。优先 16:9；正文一般 18–24pt，注释通常不低于 10–12pt。信息太多就拆页，不靠持续缩小字号解决。对齐网格和边距，图片保持比例，图表单位/图例/来源清楚。

PptxGenJS 坐标以英寸为单位，字体以 pt 为单位。宽屏为约 13.333×7.5 英寸。为每个对象明确 x/y/w/h；所有对象必须位于页内，装饰性出血除外。页面保持统一 header/footer 和 slide number，使用 defineSlideMaster。表格合理设置列宽和行高，长表拆页；不要用截图替代本应可编辑的正文。

数据图表使用 addChart，传入真实类别和值，避免不当截断坐标轴；不得填造统计结果。使用 addImage 时只用受信任 PNG/JPEG/SVG 等常见格式，保持图片长宽比，先转换复杂来源图片再嵌入。

## 修改现有 PPTX

PptxGenJS 主要用于创建，不是现有演示的无损读取器。先 inspect、用 JSZip 读取 slide XML 和关系。仅在明确了解关系和 shape ID 时作局部 OOXML 修改；保留备注、图片、图表和布局。复杂模板不要直接重建后声称保留全部动画或批注。

## 检查与交付

inspect 应返回预期页数且所有 XML 有效。检查每个对象坐标和文字长度；结构检查不能发现所有文字溢出。若可用 LibreOffice/PowerPoint，导出 PDF 后 render_pdf 并用 read 看每页，修复溢出、遮挡、字体替换和图表拥挤。若无渲染引擎，明确此限制，不生成一套近似 HTML 来假充原文件渲染。

官方文档：https://gitbrent.github.io/PptxGenJS/docs/quick-start/ 。示例：examples/powerpoint.cjs。
