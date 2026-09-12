// Syntax check every JS/MJS/CJS source file via `node --check` (CI smoke gate).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "out", "tmp", "results"]);
const EXTS = new Set([".js", ".mjs", ".cjs"]);

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full);
    } else if (e.isFile() && EXTS.has(path.extname(e.name)) && !e.name.startsWith(".")) {
      files.push(full);
    }
  }
};
walk(ROOT);

let failed = 0;
for (const f of files) {
  try {
    // app.js is loaded with type="module" in index.html despite the CommonJS package.
    const browserModule = f === path.join(ROOT, 'src', 'renderer', 'js', 'app.js');
    execFileSync(process.execPath, browserModule ? ['--check', '--input-type=module'] : ['--check', f], {
      stdio:'pipe', ...(browserModule ? {input:readFileSync(f,'utf8')} : {})
    });
  } catch (e) {
    failed++;
    console.log(`FAIL ${path.relative(ROOT, f)}`);
    console.log(String(e.stderr || e.message).split("\n").slice(0, 4).join("\n"));
  }
}
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
