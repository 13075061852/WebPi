// Inline, fixed SVG geometry: tool names never become markup.
const shapes = {
  read: '<path d="M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6"/>',
  write: '<path d="M5 3h9l5 5v5 M5 3v18h7 M14 3v6h5 M17 15v6 M14 18h6"/>',
  edit: '<path d="m4 16 11-11 4 4L8 20H4z M13 7l4 4 M14 20h6"/>',
  terminal: '<path d="m5 6 6 6-6 6 M13 18h6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5 M7 10h6"/>',
  find: '<path d="M13 20H3V5h7l2 3h9v5"/><circle cx="16" cy="16" r="3"/><path d="m18 18 3 3"/>',
  folder: '<path d="M3 5h7l2 3h9v12H3z M7 12h10 M7 16h7"/>',
  web: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18 M7 6.5h.01 M10 6.5h.01"/>',
  task: '<rect x="8" y="3" width="8" height="5" rx="1"/><path d="M12 8v5 M5 13h14 M5 13v3 M19 13v3"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3 M7 9l5 3-5 3z"/>',
  document: '<path d="M5 3h9l5 5v13H5z M14 3v6h5 M8 12h8 M8 16h8 M8 19h4"/>',
  cloud: '<path d="M6 18a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10 M12 21V11 m-4 4 4-4 4 4"/>',
  service: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6"/>',
  fallback: '<path d="m12 3 9 5v8l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v8"/>',
};
const names = {
  read: 'read', write: 'write', edit: 'edit', bash: 'terminal', powershell: 'terminal',
  grep: 'search', glob: 'find', find: 'find', ls: 'folder', web_search: 'web',
  browser: 'browser', task: 'task', image_generate: 'image', video_generate: 'video',
  office_document: 'document', cloudflare_deploy: 'cloud', service_start: 'service',
  service_status: 'service', preview_ready: 'browser',
};
export function toolIcon(name) {
  const shape = shapes[names[name]] || shapes.fallback;
  return `<span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shape}</svg><span class="tool-dot"></span></span>`;
}

export function thinkingIcon() {
  return '<svg class="think-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17v-1.5a6 6 0 1 1 6 0V17 M9 18h6 M10 21h4 M12 3V1 M4.5 5.5 3 4 M19.5 5.5 21 4 M3 12H1 M21 12h2"/><path d="m10 10 2 2 2-2 M12 12v5"/></svg>';
}
