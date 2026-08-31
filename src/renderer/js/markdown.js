/* ============================================================
   Pi Halo — markdown-lite 渲染（聊天回复 / md 文件预览 / 语法高亮共用）
   经典脚本（非 module）：顶层 function 声明挂到全局，供 app.js 使用。
   ============================================================ */
/* exported langOf, hlFile, previewURL, streamRender */

/* halo-preview URL：逐段 encodeURIComponent（文件名里的 # ? % 不会被 URL 解析器误吞） */
function previewURL(p) {
  return "halo-preview://local/" + String(p).replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

/* ---- 轻量语法高亮（文件预览代码视图） ---- */
const escFile = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HL_LANG = {
  py: "py",
  js: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", jsx: "js", java: "js", c: "js", cpp: "js", h: "js", hpp: "js", go: "js", rs: "js", php: "js", rb: "js", swift: "js", kt: "js", cs: "js",
  css: "css", json: "json",
  html: "html", htm: "html", xml: "html", vue: "html", svelte: "html", svg: "html",
  sh: "sh", bash: "sh", bat: "sh", ps1: "sh", yaml: "sh", yml: "sh", toml: "sh", ini: "sh", conf: "sh", env: "sh",
};
function langOf(ext) { return HL_LANG[ext] || null; }
const HL_RE = {
  js: /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|async|await|yield|static|get|set|delete|void|super)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()/g,
  py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|try|except|finally|with|as|lambda|None|True|False|pass|break|continue|raise|global|nonlocal|yield|async|await|assert|del|is)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][\w]*)(?=\s*\()/g,
  sh: /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|echo|export|local|return|set|source|alias|until|select|time)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][\w-]*)(?=\s*\()/g,
  css: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|([\w-]+)(?=\s*:)|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?\b)|(@[\w-]+|[.#][\w-]+)/g,
  json: /("(?:[^"\\\n]|\\.)*")(?=\s*:)|("(?:[^"\\\n]|\\.)*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
  html: /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[\w-]+)|([\w-]+)(?==)|("(?:[^"\\\n]|\\.)*")|(&gt;)/g,
};
const HL_CLS = ["c-com", "c-str", "c-kw", "c-num", "c-fn"];
function hlFile(code, lang) {
  const s = escFile(code);
  const re = HL_RE[lang];
  if (!re) return s;
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out += s.slice(last, m.index);
    const gi = m.slice(1).findIndex((g) => g !== undefined);
    out += `<span class="${HL_CLS[gi] || "c-fn"}">${m[0]}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += s.slice(last);
  return out;
}

/* ---- 完整 markdown 渲染（聊天回复 + md 文件预览共用） ---- */
const mdUrl = (u, mdPath) => {
  u = String(u || "").trim();
  if (/^(https?:|mailto:|halo-preview:|data:image\/)/i.test(u)) return u.replace(/"/g, "%22");
  if (mdPath && !/^[a-z]+:/i.test(u)) {
    const dir = mdPath.replace(/[\\/][^\\/]*$/, "");
    const parts = dir.split(/[\\/]/);
    for (const seg of u.replace(/^\.\//, "").split(/[\\/]/)) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg) parts.push(seg);
    }
    return previewURL(parts.join("/"));
  }
  return null;
};
function mdInline(s, mdPath) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code>${c}</code>`); return `\u0000C${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const u = mdUrl(url, mdPath);
    return u ? `<img src="${u}" alt="${alt.replace(/"/g, "&quot;")}" loading="lazy">` : _;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const u = mdUrl(url, mdPath);
    return u ? `<a href="${u}" target="_blank" rel="noopener">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, k) => codes[+k]);
  return s;
}
const mdSplitRow = (line) => {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
};
const LI_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
function mdList(lines, i, mdPath) {
  const ordered = /\d/.test(lines[i].match(LI_RE)[2][0]);
  const base = lines[i].match(LI_RE)[1].length;
  let out = ordered ? "<ol>" : "<ul>";
  while (i < lines.length) {
    const m = lines[i].match(LI_RE);
    if (m && m[1].length === base) {
      let text = m[3];
      const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
      out += "<li>" + (task ? `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ` + mdInline(task[2], mdPath) : mdInline(text, mdPath));
      i++;
      if (i < lines.length && LI_RE.test(lines[i]) && lines[i].match(LI_RE)[1].length > base) {
        const r = mdList(lines, i, mdPath);
        out += r.html; i = r.next;
      }
      out += "</li>";
    } else if (!lines[i].trim() && i + 1 < lines.length && LI_RE.test(lines[i + 1])) {
      i++;
    } else break;
  }
  return { html: out + (ordered ? "</ol>" : "</ul>"), next: i };
}
function mdBlocks(lines, mdPath) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(/^\s*(`{3,}|~{3,})\s*(\w*)\s*$/);
    if (m) {
      const buf = []; i++;
      while (i < lines.length && !new RegExp("^\\s*" + m[1]).test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${buf.join("\n").replace(/\n$/, "")}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) { const h = m[1].length; out.push(`<h${h}>${mdInline(m[2], mdPath)}</h${h}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const aligns = mdSplitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      const head = mdSplitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(mdSplitRow(lines[i])); i++; }
      const th = head.map((c, k) => `<th style="text-align:${aligns[k] || "left"}">${mdInline(c, mdPath)}</th>`).join("");
      const tb = rows.map((r) => "<tr>" + head.map((_, k) => `<td style="text-align:${aligns[k] || "left"}">${mdInline(r[k] ?? "", mdPath)}</td>`).join("") + "</tr>").join("");
      out.push(`<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }
    if (/^\s*&gt;/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      out.push(`<blockquote>${mdBlocks(buf, mdPath)}</blockquote>`);
      continue;
    }
    if (LI_RE.test(line)) {
      const r = mdList(lines, i, mdPath);
      out.push(r.html); i = r.next;
      continue;
    }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
      !/^\s*(`{3,}|~{3,})/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*&gt;/.test(lines[i]) && !LI_RE.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${buf.map((l) => mdInline(l, mdPath)).join("<br>")}</p>`);
  }
  return out.join("");
}
function mdRender(src, mdPath) {
  return mdBlocks(escFile(src).split("\n"), mdPath ?? null);
}

function rich(src) {
  return mdRender(src, null);
}

/* ---- 流式渲染切分：长回复只重渲染尾部，避免每 delta 全量 O(n²) ----
 * 规则：空行且其前一行不是列表续行（mdList 会把"空行+列表项"并入同一列表）时，
 * 该空行之前的段落即可冻结；代码围栏内不冻结。冻结语义与 mdBlocks 逐块渲染完全一致。 */
function mdStreamSplit(text) {
  const lines = String(text ?? "").split("\n");
  let fence = null;
  let li = false;   // 自上次冻结点起是否处于列表块
  let freeze = 0;   // lines[0..freeze) 可安全冻结
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) fence = null;
      continue;
    }
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fence = line; continue; }
    if (LI_RE.test(line)) { li = true; continue; }
    if (line.trim() === "") {
      const next = lines[i + 1];
      const nextIsLi = next !== undefined && LI_RE.test(next);
      if (!(li && nextIsLi)) freeze = i + 1; // 列表续行处不能冻结，其余空行都是安全切点
      li = nextIsLi;
      continue;
    }
    li = false;
  }
  return { frozen: lines.slice(0, freeze).join("\n"), tail: lines.slice(freeze).join("\n") };
}

/* 增量渲染：frozen 部分渲染一次后冻结，只有 tail 随 delta 重渲 */
function streamRender(el, text) {
  const { frozen, tail } = mdStreamSplit(text);
  if (el.__frozen !== frozen) {
    el.__frozen = frozen;
    el.innerHTML = rich(frozen) + (tail ? `<span class="md-tail">${rich(tail)}</span>` : "");
  } else {
    const t = el.querySelector(".md-tail");
    if (t) t.innerHTML = rich(tail);
    else if (tail) el.innerHTML = rich(frozen) + `<span class="md-tail">${rich(tail)}</span>`;
  }
}
