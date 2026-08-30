const fs = require("fs");
const f = "C:/Users/13087/AppData/Roaming/Pi Halo/halo-settings.json";
const st = JSON.parse(fs.readFileSync(f, "utf8"));
st.cwd = String(st.cwd || "").replace(/\\/g, "/");
st.projects = (st.projects || []).map((p) => ({ ...p, cwd: String(p.cwd).replace(/\\/g, "/") }));
if (st.projects && st.projects[0] && st.projects[0].lastSession) st.projects[0].lastSession = String(st.projects[0].lastSession).replace(/\\/g, "/");
fs.writeFileSync(f, JSON.stringify(st, null, 2));
console.log("normalized cwd:", st.cwd);
console.log("projects:", JSON.stringify(st.projects.map((p) => p.cwd)));
