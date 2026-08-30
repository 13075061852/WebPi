/**
 * 修复会话文件中非规范的图片形状：
 *   {type:"image", source:{type:"base64", mediaType, data}}  →  {type:"image", mimeType, data}
 * 先写 .bak-imagefix 备份再覆盖。
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error("usage: node fix-session-images.cjs <sessions-dir>"); process.exit(1); }

let fixedFiles = 0, fixedImages = 0;

const fixContent = (content) => {
  let n = 0;
  for (const c of content || []) {
    if (c.type === "image" && c.source && c.mimeType === undefined) {
      c.mimeType = c.source.mediaType || "image/png";
      c.data = c.source.data;
      delete c.source;
      n++;
    }
  }
  return n;
};

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
  const p = path.join(dir, f);
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let j;
    try { j = JSON.parse(line); } catch { return line; }
    if (j.message?.content) changed += fixContent(j.message.content);
    return changed && j ? line : line; // placeholder, replaced below
  });
  // 简单两遍法：上面统计 changed；若有修改则整体重序列化一遍
  if (changed > 0) {
    const rewritten = lines.map((line) => {
      if (!line.trim()) return line;
      let j;
      try { j = JSON.parse(line); } catch { return line; }
      if (j.message?.content) fixContent(j.message.content);
      return JSON.stringify(j);
    }).join("\n");
    fs.writeFileSync(p + ".bak-imagefix", fs.readFileSync(p));
    fs.writeFileSync(p, rewritten);
    console.log(`${f}: ${changed} image(s) fixed (backup: .bak-imagefix)`);
    fixedFiles++;
    fixedImages += changed;
  }
}
console.log(`done: ${fixedFiles} file(s), ${fixedImages} image(s) normalized`);
