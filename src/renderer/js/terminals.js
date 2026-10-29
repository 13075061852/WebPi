/* Project-scoped native terminals. Hidden sessions keep their process and scrollback. */
window.initTerminals = (getCwd, toast, openPreview) => {
  const $ = id => document.getElementById(id);
  const records = new Map(), activeByProject = new Map();
  const host = $("termHost"), pane = $("cpane-preview");
  let tiled = false, resizeTimer = 0, creating = null;
  const restoredProjects = new Set(), restoring = new Map();
  const key = () => getCwd().replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const current = () => [...records.values()].filter(r => r.project === key());
  const active = () => records.get(activeByProject.get(key()));
  const theme = () => {
    const cs = getComputedStyle(document.documentElement);
    return { background: "#00000000", foreground: cs.getPropertyValue("--txt").trim(),
      cursor: cs.getPropertyValue("--txt-dim").trim(), selectionBackground: "#71809655" };
  };
  const send = (name, data) => window.halo[name](data).catch(e => toast(e.message, "err"));
  const rememberView = () => {
    if (window.halo.ptyView) send('ptyView', { project: getCwd(), activeId: activeByProject.get(key()), open: pane.classList.contains('term-open'), tiled });
  };
  function restore() {
    const project = key();
    if (!project || restoredProjects.has(project) || !window.halo.ptyList) return Promise.resolve();
    if (restoring.has(project)) return restoring.get(project);
    const work = (async () => {
      const reply = await window.halo.ptyList();
      if (!reply?.ok) throw Error(reply?.error || '无法恢复终端');
      if (key() !== project) return;
      const saved = reply.data;
      tiled = !!saved.tiled;
      if (saved.open) { pane.classList.add('term-open'); $('btnTerm').classList.add('active'); }
      for (const record of saved.terminals) {
        if (key() !== project) return;
        if (!records.has(record.id)) await createTerminal(record);
      }
      if (key() !== project) return;
      if (records.has(saved.activeId)) activeByProject.set(project, saved.activeId);
      restoredProjects.add(project); if (current().length) render();
    })().finally(() => restoring.delete(project));
    restoring.set(project, work);
    return work;
  }
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
      tab.title = r.cwd; tab.onclick = () => { activeByProject.set(key(), r.id); render(); rememberView(); r.term.focus(); };
      const close = document.createElement("button"); close.textContent = "×";
      close.title = "关闭 " + r.name + " 并结束进程"; close.setAttribute("aria-label", close.title);
      close.onclick = () => {
        send("ptyKill", r.id); r.commands.dispose(); r.history.dispose(); r.term.dispose(); r.panel.remove(); records.delete(r.id); render(); rememberView();
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
  function create() {
    creating ||= restore().then(() => createTerminal()).then(rememberView).finally(() => { creating = null; });
    return creating;
  }
  async function createTerminal(saved = null) {
    if (current().length >= 8) return toast("每个项目最多开启 8 个终端", "err");
    const requestedProject = key();
    const { loadTerminalRuntime } = await import('./terminal-runtime.mjs');
    await loadTerminalRuntime();
    const { createTerminalLinkProvider } = await import('./terminal-links.mjs');
    const { createTerminalKeyHandler } = await import('./terminal-keys.mjs');
    const { preserveTerminalHistory } = await import('./terminal-history.mjs');
    const { waitForStartupFrame } = await import('./startup.mjs');
    const { createTerminalCommandHistory } = await import('./terminal-command-history.mjs');
    if (key() !== requestedProject || (!saved && !pane.classList.contains('term-open'))) return;
    const openLink = (event, url) => {
      event.preventDefault();
      void Promise.resolve().then(() => openPreview(url)).catch(() => toast("无法打开预览", "err"));
    };
    const id = saved?.id || crypto.randomUUID(), project = key(), cwd = saved?.cwd || getCwd();
    const panel = document.createElement("section"); panel.className = "terminal-panel";
    panel.dataset.terminalId = id;
    const usedNames = new Set(current().map(record => record.name));
    let number = 1;
    while (usedNames.has("终端 " + number)) number++;
    const name = saved?.name || "终端 " + number;
    const label = document.createElement("div"); label.className = "terminal-panel-label"; label.textContent = name;
    const mount = document.createElement("div"); mount.className = "terminal-mount";
    panel.append(label, mount); host.append(panel);
    const term = new window.Terminal({
      fontFamily: 'Cascadia Mono, Consolas, "Microsoft YaHei", monospace',
      fontSize: 13, lineHeight: 1.3, cursorStyle: "bar", cursorBlink: true,
      scrollback: 50000, theme: theme(), allowTransparency: true, allowProposedApi: false,
      ...(saved ? { cols: saved.cols, rows: saved.rows } : {}),
      linkHandler: { activate: openLink },
    });
    const history = preserveTerminalHistory(term);
    const commands = createTerminalCommandHistory(term, {
      commands: saved?.commands, replaying: !!saved, migrate: saved && !Array.isArray(saved.commands),
      remember: command => { if (window.halo.ptyCommand) send('ptyCommand', { id, command }); },
      write: data => send('ptyWrite', { id, data }),
    });
    term.registerLinkProvider(createTerminalLinkProvider(term, openLink));
    const fitAddon = new window.FitAddon.FitAddon(); term.loadAddon(fitAddon);
    const r = { id, project, cwd, name, term, history, commands, panel, fit: fitAddon, exited: false };
    records.set(id, r); activeByProject.set(project, id);
    term.open(mount);
    if (saved?.output) {
      const transcript = saved.output.replace(/\x1b\[2J\x1b\[H(?=Microsoft Windows \[)/g, '\x1bc$&');
      await new Promise(resolve => history.write(transcript + '\x1b\\\x1b[?1049l\r\n', resolve));
      // New ConPTY shells repaint from row one. Move the replayed viewport into
      // scrollback before starting the shell so its first paint cannot erase it.
      if (!saved.exited) {
        const used = term.buffer.active.cursorY + 1;
        await new Promise(resolve => history.write(`\x1b[r\x1b[${term.rows};1H` + '\r\n'.repeat(used) + '\x1b[H\x1b[0m', resolve));
      }
    }
    panel.addEventListener("mousedown", () => {
      if (activeByProject.get(r.project) !== id) { activeByProject.set(r.project, id); render(); rememberView(); }
    });
    commands.resume();
    term.onData(data => { if (!r.exited && commands.input(data)) send("ptyWrite", { id, data }); });
    const terminalKey = createTerminalKeyHandler(term, toast);
    term.attachCustomKeyEventHandler(event => terminalKey(event) && commands.key(event));
    render();
    if (saved?.exited) { r.exited = true; render(); return; }
    await document.fonts.ready;
    await waitForStartupFrame();
    if (!records.has(id)) return;
    if (key() !== requestedProject) {
      commands.dispose(); history.dispose(); term.dispose(); panel.remove(); records.delete(id); render();
      return;
    }
    // Fit before creating ConPTY, and retain its actual initial dimensions.
    // A resize sent before ptyStart completes would otherwise be discarded.
    if (mount.clientWidth >= 20 && mount.clientHeight >= 20) fitAddon.fit();
    r.cols = term.cols; r.rows = term.rows;
    const result = await window.halo.ptyStart({ id, name, cols: r.cols, rows: r.rows });
    if (!result?.ok) {
      r.exited = true; history.write("\r\n启动失败：" + (result?.error || "未知错误")); render();
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
    if (r) r.history.write(data, () => send("ptyAck", { id, size: data.length }));
    else send("ptyAck", { id, size: data.length });
  });
  window.halo.onPtyExit(({ id, exitCode }) => {
    const r = records.get(id); if (!r) return;
    r.exited = true; r.history.write("\r\n\x1b[90m进程已退出 · " + exitCode + "\x1b[0m\r\n"); render();
  });
  $("termAdd").onclick = () => create().catch(e => toast(e.message, "err"));
  $("termSplit").onclick = () => { tiled = !tiled; render(); rememberView(); };
  $("btnTerm").addEventListener("click", () => {
    const open = pane.classList.toggle("term-open"); $("btnTerm").classList.toggle("active", open);
    if (open) {
      restore().then(() => {
        if (!current().length) return create();
        render(); active()?.term.focus(); rememberView();
      }).catch(e => toast(e.message, 'err'));
    }
    else rememberView();
  });
  new ResizeObserver(fit).observe(host);
  document.addEventListener("projectstatechange", () => { render(); restore().catch(e => toast(e.message, 'err')); });
  document.addEventListener("themechange", () => { for (const r of records.values()) r.term.options.theme = theme(); });
  render();
  restore().catch(e => toast(e.message, 'err'));
};
