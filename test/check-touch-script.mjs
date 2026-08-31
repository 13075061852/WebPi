// 验证注入脚本的语法（离线，无需启动应用）：
// touch-on.js / touch-off.js / scroll-style.js 由 main.mjs 启动时读入并 executeJavaScript
import { readFileSync, writeFileSync } from "node:fs";

const files = ["src/main/inject/touch-on.js", "src/main/inject/touch-off.js", "src/main/inject/scroll-style.js"];
let fail = false;
for (const f of files) {
  const code = readFileSync(f, "utf8");
  try {
    new Function(code);
    console.log("SYNTAX OK:", f, `(${code.length} bytes)`);
  } catch (e) {
    fail = true;
    console.log("INJECTED SYNTAX ERROR:", f, e.message);
    const ln = Number(String(e.message).match(/line (\d+)/)?.[1]) || 1;
    console.log("--- around line", ln, "---");
    console.log(code.split("\n").slice(Math.max(0, ln - 3), ln + 2).join("\n"));
  }
}
process.exit(fail ? 1 : 0);
