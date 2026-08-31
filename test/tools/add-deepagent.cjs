const fs = require("fs");
const f = "C:/Users/13087/AppData/Roaming/Pi Halo/halo-settings.json";
const st = JSON.parse(fs.readFileSync(f, "utf8"));
// 补录用户切过的 deepagent 项目（旧版 pickProject 不入列表）
if (!st.projects.some((p) => p.cwd.replace(/\\/g, "/").toLowerCase() === "d:/github/deepagent")) {
  st.projects.push({ cwd: "D:/GitHub/deepagent", lastSession: null });
}
fs.writeFileSync(f, JSON.stringify(st, null, 2));
console.log("projects:", JSON.stringify(st.projects.map((p) => p.cwd)));
