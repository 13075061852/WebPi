/* Restore both palette and wallpaper before first paint. */
try {
  const selected = localStorage.getItem('halo-theme') || 'dark';
  document.documentElement.dataset.theme = ['light','mist','dunes','scholar','studio', 'garden'].includes(selected) ? 'light' : 'dark';
  document.documentElement.dataset.wallpaper = ['nebula','mist','dunes','scholar','studio', 'garden','blueprint','executive'].includes(selected) ? selected : '';
} catch {}

try {
  const saved = Number(localStorage.getItem("halo-wallpaper-transparency") ?? 35);
  const value = Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 35;
  document.documentElement.style.setProperty("--wallpaper-cover", String(1 - value / 100));
} catch {}
