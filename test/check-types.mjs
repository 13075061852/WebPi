const res = await fetch("https://registry.npmjs.org/-/v1/search?text=" + encodeURIComponent("keywords:pi-package") + "&size=20&from=0");
const j = await res.json();
const pkgTypes = (p) => {
  const kws = (p.keywords || []).map((k) => String(k).toLowerCase());
  const hay = [p.name || "", p.description || "", kws.join(" ")].join(" ").toLowerCase();
  const kwHas = (t) => kws.includes("pi-" + t) || kws.includes(t) || kws.includes(t + "s");
  const txtHas = (t) => hay.includes(t);
  const types = [];
  if (kwHas("skill") || (txtHas("skill") && !kws.includes("pi-extension"))) types.push("skill");
  if (kwHas("theme") || txtHas("theme")) types.push("theme");
  if (kwHas("prompt") || txtHas("prompt")) types.push("prompt");
  if (kwHas("extension") || /extension|adapter|toolbar|footer|overlay|dashboard|integrat|workflow/.test(hay)) types.push("extension");
  if (!types.length) types.push(kws.length ? "extension" : "package");
  return types;
};
for (const o of j.objects || []) {
  const p = o.package;
  console.log(pkgTypes(p).join(",").padEnd(14), p.name.padEnd(38), (p.keywords || []).join("|").slice(0, 60));
}
