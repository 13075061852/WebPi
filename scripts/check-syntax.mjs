// Syntax check every JS/MJS/CJS source file via `node --check` (CI smoke gate).
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { availableParallelism } from "node:os";
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
let next = 0;
await Promise.all(Array.from({length:Math.min(4,availableParallelism())},async()=>{
  while (next < files.length) {
    const f=files[next++];
    try {
      const browserModule=f===path.join(ROOT,'src','renderer','js','app.js');
      // Use stdin only for the renderer module in this CommonJS package.
      await new Promise((resolve,reject)=>{
        const child=execFile(process.execPath,browserModule?['--check','--input-type=module']:['--check',f],{windowsHide:true},error=>error?reject(error):resolve());
        if(browserModule)child.stdin.end(readFileSync(f,'utf8'));
      });
    } catch(error) {
      failed++;
      console.log(`FAIL ${path.relative(ROOT,f)}\n${String(error.stderr || error.message).split('\n').slice(0,4).join('\n')}`);
    }
  }
}));
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
