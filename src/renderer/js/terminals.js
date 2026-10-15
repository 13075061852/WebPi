/* Project-scoped native terminals. Hidden sessions keep their process and scrollback. */
window.initTerminals = (getCwd, toast, openPreview) => {
  const $ = id => document.getElementById(id);
  const records = new Map(), activeByProject = new Map();
  const host = $("termHost"), pane = $("cpane-preview");
  let tiled = false, sequence = 0, resizeTimer = 0;
  const key = () => getCwd().replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const current = () => [...records.values()].filter(r => r.project === key());
  const active = () => records.get(activeByProject.get(key()));
  const theme = () => {
    const cs = getComputedStyle(document.documentElement);
    return { background: "#00000000", foreground: cs.getPropertyValue("--txt").trim(),
      cursor: cs.getPropertyValue("--txt-dim").trim(), selectionBackground: "#71809655" };
  };
  const send = (name, data) => window.halo[name](data).catch(e => toast(e.message, "err"));
  function fit() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!pane.classList.contains("term-open")) return;
      if (document.documentElement.classList.contains('layout-motion')) { fit(); return; }
      for (const r of current()) if (!r.panel.hidden) {
        const mount = r.panel.querySelector('.terminal-mount');
        if (mount.clientWidth < 20 || mount.clientHeight < 20) continue;
        r.fit.fit();
        if (r.started && !r.exited && (r.cols !== r.term.cols || r.rows !== r.term.rows)) {
          r.cols = r.term.cols; r.rows = r.term.rows;
          send("ptyResize", { id: r.id, cols: r.cols, rows: r.rows });
        }
      }
    }, 120);
  }
  function render() {
    const list = current();
    if (!list.length) {
      pane.classList.remove("term-open");
      $("btnTerm").classList.remove("active");
    }
    if (!list.some(r => r.id === activeByProject.get(key()))) activeByProject.set(key(), list[0]?.id);
    $("termTabs").replaceChildren();
    for (const r of list) {
      const wrap = document.createElement("div"); wrap.className = "terminal-tab";
      wrap.classList.toggle("active", r === active());
      const tab = document.createElement("button");
      tab.textContent = r.name + (r.exited ? " · 已退出" : "");
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(r === active()));
      tab.title = r.cwd; tab.onclick = () => { activeByProject.set(key(), r.id); render(); r.term.focus(); };
      const close = document.createElement("button"); close.textContent = "×";
      close.title = "关闭 " + r.name + " 并结束进程"; close.setAttribute("aria-label", close.title);
      close.onclick = () => {
        send("ptyKill", r.id); r.term.dispose(); r.panel.remove(); records.delete(r.id); render();
      };
      wrap.append(tab, close); $("termTabs").append(wrap);
    }
    for (const r of records.values()) {
      r.panel.hidden = r.project !== key() || (!tiled && r !== active());
      r.panel.classList.toggle("focused", r === active());
    }
    host.classList.toggle("tiled", tiled); host.classList.toggle("empty", !list.length);
    $("termSplit").classList.toggle("active", tiled);
    $("termSplit").setAttribute("aria-pressed", String(tiled));
    fit();
  }
  async function create() {
    if (current().length >= 8) return toast("每个项目最多开启 8 个终端", "err");
    const { createTerminalLinkProvider } = await import('./terminal-links.mjs');
    const { createTerminalKeyHandler } = await import('./terminal-keys.mjs');
    const openLink = (event, url) => {
      event.preventDefault();
      void Promise.resolve().then(() => openPreview(url)).catch(() => toast("无法打开预览", "err"));
    };
    const id = crypto.randomUUID(), project = key(), cwd = getCwd();
    const panel = document.createElement("section"); panel.className = "terminal-panel";
    panel.dataset.terminalId = id;
    const name = "终端 " + (++sequence);
    const label = document.createElement("div"); label.className = "terminal-panel-label"; label.textContent = name;
    const mount = document.createElement("div"); mount.className = "terminal-mount";
    panel.append(label, mount); host.append(panel);
    const term = new window.Terminal({
      fontFamily: 'Cascadia Mono, Consolas, "Microsoft YaHei", monospace',
      fontSize: 13, lineHeight: 1.3, cursorStyle: "bar", cursorBlink: true,
      scrollback: 5000, theme: theme(), allowTransparency: true, allowProposedApi: false,
      linkHandler: { activate: openLink },
    });
    term.registerLinkProvider(createTerminalLinkProvider(term, openLink));
    const fitAddon = new window.FitAddon.FitAddon(); term.loadAddon(fitAddon);
    const r = { id, project, cwd, name, term, panel, fit: fitAddon, exited: false };
    records.set(id, r); activeByProject.set(project, id);
    term.open(mount);
    panel.addEventListener("mousedown", () => {
      if (activeByProject.get(r.project) !== id) { activeByProject.set(r.project, id); render(); }
    });
    term.onData(data => { if (!r.exited) send("ptyWrite", { id, data }); });
    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term, toast));
    render();
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!records.has(id)) return;
    // Fit before creating ConPTY, and retain its actual initial dimensions.
    // A resize sent before ptyStart completes would otherwise be discarded.
    if (mount.clientWidth >= 20 && mount.clientHeight >= 20) fitAddon.fit();
    r.cols = term.cols; r.rows = term.rows;
    const result = await window.halo.ptyStart({ id, cols: r.cols, rows: r.rows });
    if (!result?.ok) {
      r.exited = true; term.write("\r\n启动失败：" + (result?.error || "未知错误")); render();
    } else {
      if (result.data.windowsPty) term.options.windowsPty = result.data.windowsPty;
      r.started = true;
      panel.dataset.pid = result.data.pid;
      // The pane can be closed while native startup is in flight.
      if (!records.has(id)) send("ptyKill", id);
    }
    fit(); term.focus();
  }
  window.halo.onPtyOut(({ id, data }) => {
    const r = records.get(id);
    if (r) r.term.write(data, () => send("ptyAck", { id, size: data.length }));
    else send("ptyAck", { id, size: data.length });
  });
  window.halo.onPtyExit(({ id, exitCode }) => {
    const r = records.get(id); if (!r) return;
    r.exited = true; r.term.write("\r\n\x1b[90m进程已退出 · " + exitCode + "\x1b[0m\r\n"); render();
  });
  $("termAdd").onclick = () => create().catch(e => toast(e.message, "err"));
  $("termSplit").onclick = () => { tiled = !tiled; render(); };
  $("btnTerm").addEventListener("click", () => {
    const open = pane.classList.toggle("term-open"); $("btnTerm").classList.toggle("active", open);
    if (open) {
      if (!current().length) create().catch(e => toast(e.message, "err"));
      else { render(); active()?.term.focus(); }
    }
  });
  new ResizeObserver(fit).observe(host);
  document.addEventListener("projectstatechange", render);
  document.addEventListener("themechange", () => { for (const r of records.values()) r.term.options.theme = theme(); });
  render();
};
