/* ============================================================
   Nebula — the celestial activity canvas
   Every tool call becomes an orbiting body around the pi core.
   ============================================================ */
const Nebula = (() => {
  const TAU = Math.PI * 2;
  let canvas, ctx, DPR = 1, W = 0, H = 0;
  let zoom = 1, targetZoom = 1;
  let mouse = { x: 0, y: 0, sx: 0, sy: 0 };
  let busy = false;
  let showOrbits = true, showLabels = true;
  let nodes = [];        // tool bodies
  let artifacts = [];    // flying file labels
  let pulses = [];       // shockwave pulses
  let stars = [];
  let running = true;
  let t0 = performance.now();

  const TOOL_COLORS = {
    read: "#8be9ff", bash: "#fcd34d", powershell: "#fcd34d",
    edit: "#a78bfa", write: "#6ee7b7", grep: "#f0a6ff",
    find: "#93c5fd", ls: "#94a3b8", todo: "#fbbf24",
  };
  const colorOf = (t) => TOOL_COLORS[t] || "#a5b4fc";
  const RINGS = [0.24, 0.36, 0.48]; // fraction of min(W,H)

  /* ---------------- init ---------------- */
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    canvas.parentElement.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = (e.clientX - r.left) / r.width - 0.5;
      mouse.y = (e.clientY - r.top) / r.height - 0.5;
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // B3: gentle clamp so accidental scrolls never shrink the nebula too far
      targetZoom = clamp(targetZoom * (e.deltaY < 0 ? 1.06 : 0.945), 0.75, 1.6);
    }, { passive: false });
    buildStars();
    requestAnimationFrame(frame);
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function resize() {
    if (!canvas) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = canvas.width = Math.max(1, r.width * DPR);
    H = canvas.height = Math.max(1, r.height * DPR);
    canvas.style.width = r.width + "px";
    canvas.style.height = r.height + "px";
  }

  function buildStars() {
    stars = [];
    const n = 150;
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random(), y: Math.random(),
        r: (Math.random() * 1.1 + 0.25) * DPR,
        a: Math.random() * 0.5 + 0.12,
        tw: Math.random() * TAU,
        sp: Math.random() * 0.0016 + 0.0004,
        depth: Math.random() * 0.7 + 0.3,
      });
    }
  }

  /* ---------------- public API ---------------- */
  function addToolNode({ id, toolName }) {
    const ring = nodes.length % RINGS.length;
    nodes.push({
      id, toolName, color: colorOf(toolName),
      ring,
      baseR: RINGS[ring],
      ang: Math.random() * TAU,
      speed: (0.16 / (ring + 1.25)) * (Math.random() < 0.5 ? 1 : -1) * 0.55,
      born: performance.now(),
      state: "run",
      pulseAt: performance.now(),
      alpha: 0,
      wobble: Math.random() * TAU,
      dying: false,
    });
    pulses.push({ t: performance.now(), color: colorOf(toolName) });
    if (nodes.length > 40) {
      const idx = nodes.findIndex((n) => n.state !== "run");
      if (idx >= 0) nodes[idx].dying = true;
    }
  }

  function updateToolNode(id) {
    const n = nodes.find((x) => x.id === id);
    if (n) n.pulseAt = performance.now();
  }

  function endToolNode(id, isError) {
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    n.state = isError ? "err" : "done";
    n.pulseAt = performance.now();
  }

  function addArtifact({ name }) {
    artifacts.push({ name, born: performance.now(), ang: Math.random() * TAU });
    if (artifacts.length > 8) artifacts.shift();
  }

  function setBusy(v) { busy = v; }
  function setZoom(z) { targetZoom = clamp(z, 0.75, 1.6); }
  function getZoom() { return zoom; }
  // expose the internal resize (canvas size depends on pane visibility)
  function toggleOrbits(v) { showOrbits = v; }
  function toggleLabels(v) { showLabels = v; }
  function reset() { nodes = []; artifacts = []; pulses = []; }

  /* ---------------- render ---------------- */
  function frame(now) {
    if (!running) return;
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);

    zoom += (targetZoom - zoom) * 0.08;
    mouse.sx += (mouse.x - mouse.sx) * 0.04;
    mouse.sy += (mouse.y - mouse.sy) * 0.04;

    const cx = W / 2 + mouse.sx * 26 * DPR;
    const cy = H / 2 + mouse.sy * 26 * DPR;
    const unit = Math.min(W, H) * 0.5 * zoom;

    /* starfield */
    for (const s of stars) {
      const a = s.a * (0.6 + 0.4 * Math.sin(s.tw + t * s.sp * 6));
      ctx.fillStyle = `rgba(200,215,255,${a})`;
      ctx.beginPath();
      ctx.arc(s.x * W + mouse.sx * 14 * DPR * s.depth, s.y * H + mouse.sy * 14 * DPR * s.depth, s.r, 0, TAU);
      ctx.fill();
    }

    /* orbit rings */
    if (showOrbits) {
      for (let i = 0; i < RINGS.length; i++) {
        const r = unit * RINGS[i] * 2;
        ctx.strokeStyle = `rgba(148,163,255,${0.07 + i * 0.015})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2 + i, 7 + i * 3]);
        ctx.lineDashOffset = -t * (0.008 + i * 0.004) * DPR;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* shock pulses */
    pulses = pulses.filter((p) => now - p.t < 1400);
    for (const p of pulses) {
      const k = (now - p.t) / 1400;
      const r = unit * (0.1 + k * 0.9);
      ctx.strokeStyle = hexA(p.color, 0.5 * (1 - k));
      ctx.lineWidth = 1.4 * DPR;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }

    /* connections core -> nodes */
    for (const n of nodes) {
      if (n.alpha <= 0.02) continue;
      const pos = nodePos(n, cx, cy, unit, now);
      const grad = ctx.createLinearGradient(cx, cy, pos.x, pos.y);
      const a = n.state === "run" ? 0.3 : 0.1;
      grad.addColorStop(0, hexA(n.color, a));
      grad.addColorStop(1, hexA(n.color, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }

    /* nodes */
    for (const n of nodes) {
      const age = now - n.born;
      n.alpha = Math.min(n.alpha + 0.04, n.state === "run" ? 1 : 0.55);
      if (n.dying) n.alpha = Math.max(0, n.alpha - 0.03);
      if (n.alpha <= 0) continue;

      const pos = nodePos(n, cx, cy, unit, now);
      const spawn = Math.min(age / 450, 1);
      const elastic = 1 + Math.sin(spawn * Math.PI) * 0.35;
      const r = (n.state === "run" ? 4.6 : 3.4) * DPR * spawn * elastic;
      const active = n.state === "run";

      /* activity pulse halo */
      const pk = (now - n.pulseAt) / 900;
      if (pk < 1) {
        ctx.strokeStyle = hexA(n.state === "err" ? "#fda4af" : n.color, 0.65 * (1 - pk));
        ctx.lineWidth = 1.2 * DPR;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + pk * 22 * DPR, 0, TAU);
        ctx.stroke();
      }

      /* glow */
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r * 4);
      g.addColorStop(0, hexA(n.state === "err" ? "#fda4af" : n.color, 0.5 * n.alpha));
      g.addColorStop(1, hexA(n.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 4, 0, TAU);
      ctx.fill();

      /* body */
      ctx.fillStyle = hexA(n.color, n.alpha);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, TAU);
      ctx.fill();

      /* ring around running node */
      if (active) {
        ctx.strokeStyle = hexA(n.color, 0.5 * n.alpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 4.5 * DPR, t / 300 + n.ang, t / 300 + n.ang + Math.PI * 1.2);
        ctx.stroke();
      }

      /* label */
      if (showLabels && n.alpha > 0.4 && (active || n.state === "done")) {
        const la = (active ? 0.85 : 0.4) * n.alpha;
        ctx.font = `${10 * DPR}px "Cascadia Code", Consolas, monospace`;
        ctx.fillStyle = hexA(n.color, la);
        ctx.textAlign = "center";
        const label = n.state === "err" ? `${n.toolName} ✕` : n.toolName;
        ctx.fillText(label, pos.x, pos.y - r - 7 * DPR);
      }
    }

    /* artifacts flying outward */
    artifacts = artifacts.filter((a) => now - a.born < 2600);
    for (const a of artifacts) {
      const k = (now - a.born) / 2600;
      const d = unit * (0.5 + k * 0.75);
      const x = cx + Math.cos(a.ang) * d;
      const y = cy + Math.sin(a.ang) * d;
      const al = Math.sin(Math.min(k * 2.4, 1) * Math.PI) * 0.85;
      ctx.fillStyle = hexA("#6ee7b7", al);
      ctx.beginPath();
      ctx.arc(x, y, 2 * DPR, 0, TAU);
      ctx.fill();
      ctx.font = `${10 * DPR}px "Cascadia Code", Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = hexA("#a7f3d0", al);
      ctx.fillText(a.name, x, y - 8 * DPR);
    }

    /* ---- the pi core ---- */
    const breathe = 1 + Math.sin(t / (busy ? 420 : 1500)) * (busy ? 0.09 : 0.045);
    const coreR = unit * 0.16 * breathe;

    // outer glow
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.4);
    glow.addColorStop(0, busy ? "rgba(240,166,255,0.32)" : "rgba(139,233,255,0.22)");
    glow.addColorStop(0.4, "rgba(167,139,250,0.10)");
    glow.addColorStop(1, "rgba(167,139,250,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 3.4, 0, TAU);
    ctx.fill();

    // core disc
    const disc = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.35, coreR * 0.1, cx, cy, coreR);
    disc.addColorStop(0, "#e6f4ff");
    disc.addColorStop(0.45, busy ? "#c9b8ff" : "#9bd9ff");
    disc.addColorStop(1, busy ? "#6d4fd6" : "#4c3fd6");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();

    // π glyph
    ctx.save();
    ctx.shadowColor = busy ? "rgba(240,166,255,0.9)" : "rgba(139,233,255,0.8)";
    ctx.shadowBlur = 14 * DPR;
    ctx.fillStyle = "#07080f";
    ctx.font = `italic 600 ${coreR * 1.25}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("π", cx, cy + coreR * 0.06);
    ctx.restore();

    requestAnimationFrame(frame);
  }

  function nodePos(n, cx, cy, unit, now) {
    const r = unit * n.baseR * 2 + Math.sin(now / 900 + n.wobble) * 5 * DPR;
    const a = n.ang + (now - t0) * 0.001 * n.speed;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.92 };
  }

  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  return {
    init, addToolNode, updateToolNode, endToolNode, addArtifact,
    setBusy, setZoom, getZoom, toggleOrbits, toggleLabels, reset, resize,
  };
})();
window.Nebula = Nebula;
