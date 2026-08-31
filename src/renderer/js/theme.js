/* Pi Halo — paint the saved theme before first frame to avoid flash.
   Must stay a tiny blocking classic script in <head>. */
try { document.documentElement.dataset.theme = localStorage.getItem("halo-theme") || "dark"; } catch {}
