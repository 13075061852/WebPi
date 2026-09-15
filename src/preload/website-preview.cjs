/* global window */
const { ipcRenderer } = require('electron');
// Runs in the isolated world. No Node or application API is exposed to the site.
window.addEventListener('wheel', event => {
  if (!event.ctrlKey || !event.deltaY) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.sendToHost('website-zoom', event.deltaY < 0 ? 'in' : 'out');
}, {capture:true, passive:false});
