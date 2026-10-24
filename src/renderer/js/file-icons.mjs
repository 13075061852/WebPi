// Static SVGs share one stroke system; file names only select a known icon.
const page = '<path d="M14 3H6v18h12V7Z M14 3v5h4"/>';
const label = text => `<rect x="3" y="3" width="18" height="18" rx="3"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial,sans-serif" font-size="10" font-weight="700">${text}</text>`;
const icons = {
  file: ['#7b8594', page],
  html: ['#d76536', '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>'],
  css: ['#4383c5', '<path d="m10 3-3 18M17 3l-3 18M3 9h18M2 15h18"/>'],
  javascript: ['#ad8722', label('JS')],
  typescript: ['#397dcc', label('TS')],
  react: ['#3897ac', '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>'],
  vue: ['#459578', '<path d="M2 5h5l5 8 5-8h5L12 22ZM7 5h3l2 3 2-3h3"/>'],
  python: ['#5489b7', '<path d="M5 11V7a3 3 0 0 1 3-3h8v8H8v8H5a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3h8m6 2v4a3 3 0 0 1-3 3H8m8-16h3a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3h-8"/><circle cx="9" cy="7" r=".8" fill="currentColor" stroke="none"/><circle cx="16" cy="17" r=".8" fill="currentColor" stroke="none"/>'],
  code: ['#7187bd', '<path d="m8 6-6 6 6 6m8-12 6 6-6 6"/>'],
  json: ['#8b953c', '<path d="M9 3H7a2 2 0 0 0-2 2v4l-3 3 3 3v4a2 2 0 0 0 2 2h2m6-18h2a2 2 0 0 1 2 2v4l3 3-3 3v4a2 2 0 0 1-2 2h-2"/><circle cx="12" cy="9" r=".8"/><circle cx="12" cy="15" r=".8"/>'],
  config: ['#7c899d', '<path d="m10 2 4 0 1 3 3 1 3 3-2 3 2 3-3 3-3 1-1 3h-4l-1-3-3-1-3-3 2-3-2-3 3-3 3-1Z"/><circle cx="12" cy="12" r="3"/>'],
  tsconfig: ['#397dcc', '<path d="M5 3h14v18H5ZM8 7h8M8 12h8M8 17h8"/><circle cx="10" cy="7" r="1.5" fill="currentColor"/><circle cx="14" cy="12" r="1.5" fill="currentColor"/><circle cx="10" cy="17" r="1.5" fill="currentColor"/>'],
  package: ['#b36a50', '<path d="m12 2 9 5v10l-9 5-9-5V7ZM3 7l9 5 9-5M12 12v10M8 4l9 5v5"/>'],
  lock: ['#9a8546', '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>'],
  vite: ['#9263c6', '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>'],
  cloud: ['#d88039', '<path d="M7 18a5 5 0 1 1 .3-10 6 6 0 0 1 11.5 2A4 4 0 0 1 19 18Z"/>'],
  readme: ['#638ca6', '<path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1ZM12 5v15M5 8h3M5 12h3M16 8h3M16 12h3"/>'],
  markdown: ['#638ca6', '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 15V9l3 3 3-3v6m6-6v6m-2-2 2 2 2-2"/>'],
  text: ['#7c899d', page + '<path d="M8 12h6M8 16h6"/>'],
  pdf: ['#cb6565', page + '<path d="M8 17c3-4 4-7 3-7-2 0 0 7 4 6 2-1-7-2-7 1Z"/>'],
  word: ['#4f83ba', page + '<path d="m7 12 1.5 6L11 13l2.5 5 1.5-6"/>'],
  sheet: ['#579469', '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 9v12"/>'],
  slides: ['#bc7950', '<path d="M3 3h18v13H3ZM12 16v6M7 22l5-6 5 6M7 12V9M12 12V6M17 12v-2"/>'],
  image: ['#916eb1', '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 3-7 6 8"/>'],
  svg: ['#916eb1', '<path d="M4 18C4 3 20 3 20 18M4 5h16"/><rect x="2" y="16" width="4" height="4"/><rect x="18" y="16" width="4" height="4"/><rect x="10" y="3" width="4" height="4"/>'],
  video: ['#9870b4', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 4v16M18 4v16M2 9h4M2 15h4M18 9h4M18 15h4m-12-6 5 3-5 3Z"/>'],
  audio: ['#b86f95', '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>'],
  archive: ['#b0934e', page + '<path d="M11 3v3m2 0v3m-2 0v3m2 0v3M10 17h4v3h-4Z"/>'],
  database: ['#579b9d', '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>'],
  terminal: ['#759b70', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>'],
  git: ['#cb775c', '<path d="m12 2 10 10-10 10L2 12ZM8 6l8 8M8 6v10"/><circle cx="8" cy="6" r="1.5"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="14" r="1.5"/>'],
  env: ['#a58b47', '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>'],
  binary: ['#818c9b', '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4Z"/>'],
};
const groups = {
  html: 'html htm xhtml', css: 'css scss sass less', javascript: 'js mjs cjs', typescript: 'ts mts cts', react: 'jsx tsx', vue: 'vue svelte', python: 'py pyw ipynb',
  code: 'c h cc cpp hpp cs java kt kts go rs rb php swift dart lua r', json: 'json jsonc json5', config: 'yaml yml toml ini conf config',
  markdown: 'md mdx markdown', text: 'txt log csv srt vtt', pdf: 'pdf', word: 'doc docx odt rtf', sheet: 'xls xlsx ods', slides: 'ppt pptx odp',
  image: 'png jpg jpeg gif webp bmp ico avif heic tiff', svg: 'svg', video: 'mp4 webm mov mkv avi m4v', audio: 'mp3 wav ogg flac aac m4a opus',
  archive: 'zip gz tgz bz2 xz rar 7z tar', database: 'sql db sqlite sqlite3', terminal: 'sh bash zsh bat cmd ps1', binary: 'exe dll bin wasm tsbuildinfo',
};
const extensions = new Map(Object.entries(groups).flatMap(([kind, list]) => list.split(' ').map(ext => [ext, kind])));

export function fileIconKind(value) {
  const name = String(value || '').replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|uv\.lock)$/.test(name)) return 'lock';
  if (/^(package\.json|cargo\.toml|pyproject\.toml|composer\.json|gemfile)$/.test(name)) return 'package';
  if (/^tsconfig(?:\..+)?\.json$/.test(name)) return 'tsconfig';
  if (/^vite\.config\./.test(name)) return 'vite';
  if (/^wrangler(?:\..+)?\.(jsonc?|toml)$/.test(name)) return 'cloud';
  if (/^readme(?:\.|$)/.test(name)) return 'readme';
  if (/^\.env(?:\.|$)/.test(name)) return 'env';
  if (/^\.git/.test(name)) return 'git';
  if (/^(dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/.test(name)) return 'package';
  return extensions.get(name.includes('.') ? name.split('.').pop() : '') || 'file';
}

export function fileIconFor(name) {
  const kind = fileIconKind(name);
  const [color, paths] = icons[kind];
  return `<svg viewBox="0 0 24 24" class="ic f-ic" data-file-icon="${kind}" aria-hidden="true" style="color:${color}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
