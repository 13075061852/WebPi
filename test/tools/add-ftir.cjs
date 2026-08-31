const fs = require("fs");
const f = "C:/Users/13087/AppData/Roaming/Pi Halo/halo-settings.json";
const st = JSON.parse(fs.readFileSync(f, "utf8"));
if (!st.projects.some((p) => String(p.cwd).replace(/\\/g, "/").toLowerCase() === "d:/github/ftir")) {
  st.projects.push({ cwd: "D:/GitHub/FTIR", lastSession: null });
}
fs.writeFileSync(f, JSON.stringify(st, null, 2));
console.log("projects:", JSON.stringify(st.projects.map((p) => p.cwd)));
