// 验证 main.mjs 中 TOUCH_ON 注入脚本的语法（离线，无需启动应用）
import { readFileSync } from "node:fs";
const s = readFileSync("src/main/main.mjs", "utf8");
const start = s.indexOf("const TOUCH_ON = [");
const end = s.indexOf("].join(\"\\n\");", start);
if (start < 0 || end < 0) { console.log("TOUCH_ON NOT FOUND"); process.exit(1); }
const arrText = s.slice(start + "const TOUCH_ON = ".length, end + 1);
const arr = eval(arrText);
const code = arr.join("\n");
try {
  new Function(code);
  console.log("INJECTED SCRIPT SYNTAX OK, lines:", arr.length);
} catch (e) {
  console.log("INJECTED SYNTAX ERROR:", e.message);
  const ln = Number(String(e.message).match(/line (\d+)/)?.[1]) || 1;
  console.log("--- around line", ln, "---");
  console.log(code.split("\n").slice(Math.max(0, ln - 3), ln + 2).join("\n"));
  process.exit(1);
}
