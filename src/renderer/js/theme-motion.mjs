// Reveal the new palette from its control without scaling or blurring the page.
export function createThemeMotion({ applyTheme }) {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const properties = ['--theme-origin-x', '--theme-origin-y', '--theme-radius'];
  let active = null;

  function clean(run) {
    run.marker?.remove();
    run.animations.forEach(animation => animation.cancel());
    if (active !== run) return;
    active = null;
    root.classList.remove('theme-x');
    properties.forEach(property => root.style.removeProperty(property));
  }

  function cancel() {
    if (!active) return;
    const run = active;
    // Clear ownership first: a skipped snapshot callback must not apply an old choice.
    active = null;
    run.transition?.skipTransition();
    clean(run);
    root.classList.remove('theme-x');
    properties.forEach(property => root.style.removeProperty(property));
  }

  function finish() {
    if (active && !active.applied) applyTheme(active.theme);
    cancel();
  }

  function switchTo(theme, control) {
    cancel();
    if (!document.startViewTransition || reduced.matches || document.hidden) {
      applyTheme(theme);
      return;
    }
    const bounds = control.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth, bounds.x + bounds.width / 2));
    const y = Math.max(0, Math.min(innerHeight, bounds.y + bounds.height / 2));
    // Continue beyond the last corner before retiring the snapshot.
    const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))) + 8;
    const run = { theme, applied: false, animations: [], marker: document.createElement('span') };
    active = run;
    root.style.setProperty('--theme-origin-x', `${x}px`);
    root.style.setProperty('--theme-origin-y', `${y}px`);
    root.style.setProperty('--theme-radius', `${radius}px`);
    root.classList.add('theme-x');
    // The named transparent layer gives the waves their own transition group,
    // above the two palette snapshots, without copying or filtering UI content.
    run.marker.className = 'theme-ripple-anchor';
    run.marker.setAttribute('aria-hidden', 'true');
    document.body.append(run.marker);
    try {
      run.transition = document.startViewTransition(() => {
        if (active !== run) return;
        applyTheme(theme);
        run.applied = true;
      });
    } catch {
      applyTheme(theme);
      clean(run);
      return;
    }
    void run.transition.ready.then(() => {
      if (active !== run) return;
      const options = { duration: 720, easing: 'linear', fill: 'both' };
      const reveal = root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { ...options, pseudoElement: '::view-transition-new(root)' });
      reveal.id = 'theme-reveal';
      run.animations.push(reveal);
      void reveal.finished.catch(() => {});
      const wave = root.animate([
        { offset: 0, transform: 'scale(0)', opacity: 0 },
        { offset: .08, opacity: 1 },
        { offset: .6, opacity: .65 },
        { offset: 1, transform: 'scale(1)', opacity: 0 },
      ], { ...options, pseudoElement: '::view-transition-group(theme-ripple)' });
      wave.id = 'theme-wave';
      run.animations.push(wave);
      void wave.finished.catch(() => {});
    }).catch(() => {
      // Interrupted captures still leave the requested palette usable.
      if (active === run) finish();
    });
    void run.transition.finished.catch(() => {}).finally(() => clean(run));
  }

  window.addEventListener('resize', finish);
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(); });
  reduced.addEventListener('change', () => { if (reduced.matches) finish(); });
  return { switchTo, cancel, get target() { return active?.theme; } };
}
