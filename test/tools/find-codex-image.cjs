const fs = require("fs");
const src = fs.readFileSync("C:/Users/13087/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/openai-codex-responses-GJVBJXLB.js", "utf8");
for (const kw of ["image_url", "data:${", "mimeType", "mediaType"]) {
  let i = -1, n = 0;
  while ((i = src.indexOf(kw, i + 1)) !== -1 && n < 8) {
    console.log("---", kw, "@", i);
    console.log(JSON.stringify(src.slice(Math.max(0, i - 180), i + 130)));
    n++;
  }
}
