const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let main;
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch("http://127.0.0.1:" + PORT + "/json")).json(); main = l.find((t) => t.type === "page" && t.url.endsWith("index.html")); if (main) break; } catch {}
  await sleep(500);
}
if (!main) { console.log("NO WINDOW"); process.exit(1); }
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3200);
console.log("open html:", await ev('(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && /[.]html$/.test(e.querySelector(".fname").textContent)); if (!row) return "NOT FOUND"; row.click(); return "ok"; })()'));
await sleep(1500);
for (const dev of ["desktop", "tablet", "mobile"]) {
  await ev('document.querySelector("#pvBody [data-dev=' + dev + ']") ? document.querySelector("#pvBody [data-dev=' + dev + ']").click() : document.querySelector(".pvdev[data-dev=' + dev + ']").click()');
  await sleep(700);
  const info = await ev('(() => {' +
    'const body = document.getElementById("pvBody");' +
    'const shell = document.querySelector("#pvBody .dev-shell");' +
    'const ifr = document.querySelector("#pvBody iframe");' +
    'const bs = body ? getComputedStyle(body) : null;' +
    'const ss = shell ? getComputedStyle(shell) : null;' +
    'const is = ifr ? getComputedStyle(ifr) : null;' +
    'const pr = body.getBoundingClientRect();' +
    'const sr = shell ? shell.getBoundingClientRect() : null;' +
    'return JSON.stringify({' +
    ' dev: "' + dev + '",' +
    ' pvBodyBg: bs ? bs.backgroundColor + " / " + bs.backgroundImage.slice(0, 40) : null,' +
    ' pvBodyPad: bs ? bs.padding : null,' +
    ' shellBg: ss ? ss.backgroundImage.slice(0, 60) || ss.backgroundColor : null,' +
    ' iframeBg: is ? is.backgroundColor : null,' +
    ' shellRect: sr ? Math.round(sr.width) + "x" + Math.round(sr.height) : null,' +
    ' bodyRect: Math.round(pr.width) + "x" + Math.round(pr.height)' +
    '});' +
  '})()');
  console.log(info);
}
process.exit(0);
