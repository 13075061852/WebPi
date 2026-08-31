const B = String.fromCharCode(92);
const src = `^([A-Za-z]:${B}[^>${B}r${B}n]*>)$`;
console.log("source:", JSON.stringify(src));
const RE = new RegExp(src);
const s = "D:" + B + "GitHub" + B + "WebPi>";
console.log("test:", JSON.stringify(s), "=>", RE.test(s));
// 逐段排查
console.log("A:", /^[A-Za-z]:/.test(s));
console.log("B:", new RegExp(`^[A-Za-z]:${B}`).test(s));
console.log("C:", new RegExp(`^[A-Za-z]:${B}[^>${B}r${B}n]*`).test(s));
console.log("D:", new RegExp(`^[A-Za-z]:${B}[^>${B}r${B}n]*>`).test(s));
