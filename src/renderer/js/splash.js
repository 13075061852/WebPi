/* Pi Halo splash — particle convergence choreography */
(() => {
  const canvas = document.getElementById("stars");
  const stage = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  let W = 0, H = 0, CX = 0, CY = 0;
  function resize() {
    W = canvas.width = innerWidth * DPR;
    H = canvas.height = innerHeight * DPR;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    CX = W / 2; CY = H / 2 - 26 * DPR;
  }
  resize();
  addEventListener("resize", resize);

  /* ---- particles: converge from the void into an orbital ring ---- */
  const N = 170;
  const RING_R = 88 * DPR;
  const parts = [];
  const rand = (a, b) => a + Math.random() * (b - a);
  const palette = ["255,255,255", "196,196,202", "140,140,148"];

  for (let i = 0; i < N; i++) {
    const ang = rand(0, Math.PI * 2);
    const dist = rand(240, 420) * DPR;
    parts.push({
      ang,
      dist,
      targetAng: (i / N) * Math.PI * 2 + rand(-0.14, 0.14),
      speed: rand(0.0022, 0.0042),
      size: rand(0.7, 2.1) * DPR,
      color: palette[(Math.random() * palette.length) | 0],
      alpha: 0,
      maxAlpha: rand(0.35, 0.95),
      glow: Math.random() < 0.16,
      seed: Math.random() * 1000,
    });
  }

  // timeline helpers (ms)
  const T0 = performance.now();
  const CONVERGE_START = 450;
  const CONVERGE_END = 1750;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  let rafId;
  function frame(now) {
    const t = now - T0;
    ctx.clearRect(0, 0, W, H);

    // faint breathing core before the glyph appears
    const coreA = Math.min(t / 700, 1) * (0.5 + 0.5 * Math.sin(now / 420));
    const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, 26 * DPR);
    g.addColorStop(0, `rgba(255,255,255,${0.55 * coreA})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(CX, CY, 26 * DPR, 0, Math.PI * 2);
    ctx.fill();

    for (const p of parts) {
      // appear
      const born = CONVERGE_START + (p.seed % 600);
      if (t > born) p.alpha = Math.min(p.alpha + 0.03, p.maxAlpha);

      // converge progress per particle (staggered)
      const localT = Math.min(Math.max((t - born) / (CONVERGE_END - CONVERGE_START + 500), 0), 1);
      const e = easeInOut(localT);

      const dist = p.dist * (1 - e) + RING_R * e;
      const ang = p.ang + (p.targetAng - p.ang) * e + t * p.speed * (0.4 + 0.6 * e);

      const x = CX + Math.cos(ang) * dist;
      const y = CY + Math.sin(ang) * dist * 0.94;

      // trail
      const tx = CX + Math.cos(ang - 0.06 - p.speed * 8) * dist;
      const ty = CY + Math.sin(ang - 0.06 - p.speed * 8) * dist * 0.94;

      ctx.strokeStyle = `rgba(${p.color},${p.alpha * 0.35})`;
      ctx.lineWidth = p.size * 0.8;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();

      if (p.glow) {
        const gg = ctx.createRadialGradient(x, y, 0, x, y, p.size * 4);
        gg.addColorStop(0, `rgba(${p.color},${p.alpha * 0.8})`);
        gg.addColorStop(1, `rgba(${p.color},0)`);
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(x, y, p.size * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${p.color},${p.alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  /* ---- finish / skip ---- */
  let done = false;
  function finish() {
    if (done) return;
    done = true;
    stage.classList.add("leave");
    try { window.halo.splashDone(); } catch {}
    setTimeout(() => cancelAnimationFrame(rafId), 700);
  }

  const TOTAL = 4200;
  setTimeout(finish, TOTAL);
  addEventListener("click", finish);
  addEventListener("keydown", finish);
})();
