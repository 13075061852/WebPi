const PORT = process.argv[2] || "9371";
const DEV = process.argv[3] || "mobile";
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
await ev('(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && /[.]html$/.test(e.querySelector(".fname").textContent)); if (row) row.click(); })()');
await sleep(1800);
await ev('document.querySelector(".pvdev[data-dev=' + DEV + ']").click()');
await sleep(900);
const s = await ev('(function(){' +
  'const pv = document.getElementById("pvBody");' +
  'const shell = pv.querySelector(".dev-shell");' +
  'const ss = getComputedStyle(shell);' +
  'const sb = pv.querySelector(".dev-statusbar");' +
  'const sbStyle = sb ? getComputedStyle(sb) : null;' +
  'const ifr = pv.querySelector("iframe");' +
  'return JSON.stringify({' +
  ' cls: pv.className.replace("pv-body ",""),' +
  ' shellBg: ss.backgroundImage.slice(0, 40) || ss.backgroundColor,' +
  ' shellW: Math.round(shell.getBoundingClientRect().width),' +
  ' statusbarDisplay: sb ? sbStyle.display : "no-el",' +
  ' sbH: sb ? Math.round(sb.getBoundingClientRect().height) : 0,' +
  ' iframeBg: getComputedStyle(ifr).backgroundColor,' +
  ' iframeR: getComputedStyle(ifr).borderRadius' +
  '});})()');
console.log(DEV, s);
process.exit(0);
