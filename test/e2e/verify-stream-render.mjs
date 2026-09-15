/* mdStreamSplit / streamRender 正确性验证：
 * 对任意文本前缀，增量渲染（冻结段落 + 尾部重渲）必须与全量 mdRender 输出完全一致。
 * 覆盖：段落、列表（含空行续项）、代码围栏（含空行）、表格、引用、标题、任务列表。 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const code = readFileSync("src/renderer/js/markdown.js", "utf8");
const sandbox = {};
const fn = new Function("window", "document", code + "\n;return { mdRender, rich, mdStreamSplit, streamRender };");
const { mdRender, mdStreamSplit, streamRender } = fn(sandbox, { documentElement: { dataset: { projectCwd: "" } } });
assert.equal(mdRender('\uFEFF# 标题\r\n\r\n  ## 章节\r\n正文\r\n'), '<h1>标题</h1><h2>章节</h2><p>正文</p>');
assert.match(mdRender('```txt\r\n# 原样代码\r\n```'), /<pre><code># 原样代码<\/code><\/pre>/);

const portTable = '**TCP 端口**\n| 端口 | 监听地址 | 进程 |\n|------|----------|------|\n| 22 | 0.0.0.0 / [::] | sshd |\n**UDP 端口**\n| 端口 | 监听地址 | 进程 |\n|------|----------|------|\n| 68 | 0.0.0.0 | dhclient |';
assert.equal((mdRender(portTable).match(/<table>/g) || []).length, 2);
assert.match(mdRender(portTable), /<td[^>]*>sshd<\/td>/);
assert.doesNotMatch(mdRender('文字 | 分隔\n---'), /<table>/);
const CASES = [
  portTable,
  "简单段落。",
  "第一段。\n\n第二段。",
  "第一段。\n\n第二段。\n\n第三段。",
  "- 项目甲\n- 项目乙\n\n- 项目丙",                      // 列表跨空行续项（mdList 合并）
  "1. 第一步\n2. 第二步\n\n- 换个列表",
  "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n结尾段落",
  "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n表格后的段落",
  "> 引用第一行\n> 引用第二行\n\n> 新引用",
  "# 标题\n\n正文",
  "# Windows 标题\r\n\r\n## 章节\r\n\r\n正文",
  "- [x] 已完成\n- [ ] 未完成",
  "**加粗** 和 *斜体* 与 `代码` 混合\n\n第二段带 [链接](https://example.com)",
  "```\n无语言围栏\n```\n\n普通文本",
  "段一\n\n段二\n\n段三\n\n段四\n\n段五",
];

const normalize = (html) => html.replace(/<span class="md-tail">([\s\S]*?)<\/span>$/, "$1");

let fails = 0;
for (const text of CASES) {
  // 模拟逐字符流式：每个前缀都必须一致
  for (let i = 1; i <= text.length; i++) {
    const prefix = text.slice(0, i);
    const full = mdRender(prefix);
    const el = { __frozen: null, innerHTML: "", querySelector: () => null };
    streamRender(el, prefix);
    if (normalize(el.innerHTML) !== full) {
      fails++;
      console.log("MISMATCH at prefix len", i, "of case:", JSON.stringify(text.slice(0, 60)));
      console.log("  full:", JSON.stringify(full.slice(0, 200)));
      console.log("  incr:", JSON.stringify(el.innerHTML.slice(0, 200)));
      if (fails > 3) process.exit(1);
      break;
    }
  }
  // 末尾追加空行序列也须一致
  for (const extra of ["\n", "\n\n", "\n\n\n"]) {
    const t = text + extra;
    const full = mdRender(t);
    const el = { __frozen: null, innerHTML: "", querySelector: () => null };
    streamRender(el, t);
    if (normalize(el.innerHTML) !== full) {
      fails++;
      console.log("MISMATCH with trailing", JSON.stringify(extra), "case:", JSON.stringify(text.slice(0, 60)));
      break;
    }
  }
}
// 冻结前进路径：两次连续渲染（第二次 frozen 不变、只重渲 tail）
{
  const text = "甲。\n\n乙。\n\n丙。";
  const el = { __frozen: null, innerHTML: "", querySelector: () => null };
  streamRender(el, "甲。\n\n乙。");
  const snap1 = el.innerHTML;
  streamRender(el, text);
  const snap2 = el.innerHTML;
  const full = mdRender(text);
  if (normalize(snap1) !== mdRender("甲。\n\n乙。")) { fails++; console.log("MISMATCH frozen-advance step1"); }
  if (normalize(snap2) !== full) { fails++; console.log("MISMATCH frozen-advance step2"); }
  // 第三次：frozen 不变，只动 tail
  streamRender(el, text + "。");
  if (normalize(el.innerHTML) !== mdRender(text + "。")) { fails++; console.log("MISMATCH tail-only"); }
}
console.log(fails ? `FAILED: ${fails} mismatches` : "ALL STREAM RENDER TESTS PASS");
process.exit(fails ? 1 : 0);
