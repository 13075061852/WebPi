/* Restore both palette and wallpaper before first paint. */
try {
  const saved = localStorage.getItem('halo-theme') || 'dark';
  const selected = [...Object.keys(window.HALO_THEME_PALETTES || {}), 'light', 'dark', 'glass'].includes(saved) ? saved : 'dark';
  if (selected !== saved) localStorage.setItem('halo-theme', selected);
  document.documentElement.dataset.theme = window.HALO_THEME_PALETTES?.[selected] || (selected === 'glass' ? 'light' : selected);
  document.documentElement.dataset.surface = selected === 'glass' ? 'glass' : '';
  document.documentElement.dataset.wallpaper = Object.hasOwn(window.HALO_THEME_PALETTES || {}, selected) ? selected : '';
} catch {}

try {
  const saved = Number(localStorage.getItem("halo-wallpaper-transparency") ?? 35);
  const value = Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 35;
  document.documentElement.style.setProperty("--wallpaper-cover", String(1 - value / 100));
} catch {}
