/** Scan session jsonl for image blocks and validate formats */
const fs = require("fs");
const file = process.argv[2];
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
let msgs = [];
for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (j.type === "message") msgs.push(j.message);
}
console.log("total messages:", msgs.length);

function magic(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 6 && buf.slice(0, 3).toString() === "GIF") return "image/gif";
  if (buf.length > 12 && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return "UNKNOWN";
}

let found = 0;
msgs.forEach((m, i) => {
  const walk = (content) => {
    for (const c of content || []) {
      if (c.type === "image") {
        found++;
        const data = c.source?.data ?? c.data ?? "";
        const mt = c.source?.mediaType ?? c.mimeType ?? "(none)";
        if (!data) { console.log(`msg ${i} [${m.role}] IMAGE NO DATA mt=${mt}`); continue; }
        const buf = Buffer.from(data, "base64");
        const real = magic(buf);
        const flag = real === mt ? "ok" : real === "UNKNOWN" ? "*** BAD ***" : "*** MISMATCH ***";
        console.log(`msg ${i} [${m.role}] declared=${mt} actual=${real} bytes=${buf.length} b64len=${data.length} ${flag}`);
      }
      if (c.type === "toolResult" && Array.isArray(c.output)) {
        for (const o of c.output) {
          if (o.type === "image") {
            found++;
            const data = o.source?.data ?? "";
            const buf = Buffer.from(data, "base64");
            const real = magic(buf);
            console.log(`msg ${i} [${m.role}] toolResult image declared=${o.source?.mediaType} actual=${real} bytes=${buf.length} ${real === o.source?.mediaType ? "ok" : "*** BAD ***"}`);
          }
        }
      }
    }
  };
  walk(m.content);
});
console.log("images found:", found);
