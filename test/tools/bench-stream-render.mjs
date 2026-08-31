/* 性能基准 v3：正确模拟 DOM 语义 —— 全量替换会重建 .md-tail 节点（引用失效），
 * 之后的 delta 只对 tail span 做局部 innerHTML 写入（真实浏览器行为）。 */
import { readFileSync } from "node:fs";

const code = readFileSync("src/renderer/js/markdown.js", "utf8");
const fn = new Function("window", code + "\n;return { rich, streamRender };");
const { rich, streamRender } = fn({});

const para = (i) => `## 段落 ${i}\n\n${"这是正文内容，包含**加粗**与`代码`，用于模拟真实长回复。".repeat(20)}`;
const longText = Array.from({ length: 20 }, (_, i) => para(i)).join("\n\n");

function makeEl() {
  const el = {
    __frozen: null,
    _root: "",
    _tail: { innerHTML: "" },
    set innerHTML(v) { this._root = v; this._tail = { innerHTML: "" }; }, // 全量替换：span 重建
    get innerHTML() { return this._root; },
    querySelector() { return this._tail; },
  };
  return el;
}

function run(mode) {
  let text = "";
  let writes = 0, fullWrites = 0, chars = 0;
  const el = makeEl();
  const t0 = performance.now();
  for (let i = 0; i < longText.length; i += 8) {
    text = longText.slice(0, i + 8);
    if (mode === "old") {
      el.innerHTML = rich(text);
      fullWrites++;
      chars += el.innerHTML.length;
    } else {
      const before = el.innerHTML.length;
      streamRender(el, text);
      // 判断本次是整体替换还是 tail 局部更新
      if (el.innerHTML !== before && el._root !== before) { /* noop */ }
      if (el.querySelector() === el._tail) { /* 未重建 */ }
      writes++;
      // 通过 root 引用是否被替换判断：setter 里 _tail 重建了
      // 简单可靠：记录 setter 调用时的长度
      chars += el._lastWriteLen || 0;
    }
    writes++;
  }
  return { ms: performance.now() - t0, writes, fullWrites, chars };
}

// 更直接的统计：在 setter 中记录每次赋值的长度
function run2(mode) {
  let text = "";
  let writes = 0, fullWrites = 0, chars = 0;
  const el = makeEl();
  const origSet = Object.getOwnPropertyDescriptor(el, "innerHTML").set;
  Object.defineProperty(el, "innerHTML", {
    set(v) {
      writes++;
      if (String(v).includes('class="md-tail"')) fullWrites++;
      chars += String(v).length;
      origSet.call(el, v);
    },
    get() { return el._root; },
  });
  const t0 = performance.now();
  for (let i = 0; i < longText.length; i += 8) {
    text = longText.slice(0, i + 8);
    if (mode === "old") el.innerHTML = rich(text);
    else streamRender(el, text);
  }
  return { ms: performance.now() - t0, writes, fullWrites, chars };
}

const oldR = run2("old");
const newR = run2("new");
console.log("旧方式(全量重渲):", JSON.stringify(oldR));
console.log("新方式(增量冻结):", JSON.stringify(newR));
console.log(`DOM 写入字符量: ${(newR.chars / 1e6).toFixed(1)}M vs ${(oldR.chars / 1e6).toFixed(1)}M → 下降 ${(100 - (newR.chars / oldR.chars) * 100).toFixed(1)}%`);
console.log(`整体替换次数: ${oldR.fullWrites} → ${newR.fullWrites}`);
