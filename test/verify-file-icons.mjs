import assert from 'node:assert/strict';
import { fileIconFor, fileIconKind } from '../src/renderer/js/file-icons.mjs';

const cases = {
  'index.html': 'html', 'styles.scss': 'css', 'app.js': 'javascript', 'main.ts': 'typescript',
  'Component.tsx': 'react', 'App.vue': 'vue', 'script.py': 'python',
  'package.json': 'package', 'package-lock.json': 'lock', 'pnpm-lock.yaml': 'lock',
  'tsconfig.app.json': 'tsconfig', 'tsconfig.node.tsbuildinfo': 'binary',
  'vite.config.ts': 'vite', 'wrangler.jsonc': 'cloud', 'wrangler.toml': 'cloud',
  'README.md': 'readme', 'guide.md': 'markdown', '.env.local': 'env', '.gitignore': 'git',
  'report.pdf': 'pdf', 'report.docx': 'word', 'budget.xlsx': 'sheet', 'slides.pptx': 'slides',
  'photo.PNG': 'image', 'logo.svg': 'svg', 'clip.mp4': 'video', 'voice.wav': 'audio',
  'backup.tar.gz': 'archive', 'local.sqlite': 'database', 'setup.ps1': 'terminal',
  'C:\\project\\PACKAGE.JSON': 'package', '/project/vite.config.mjs': 'vite',
  'unknown.extension': 'file', 'no-extension': 'file', '.': 'file',
};
for (const [name, expected] of Object.entries(cases)) {
  assert.equal(fileIconKind(name), expected, name);
  const svg = fileIconFor(name);
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'));
  assert.ok(svg.includes(`data-file-icon="${expected}"`));
  assert.ok(svg.includes('aria-hidden="true"'));
}
// Untrusted file names select static markup and can never become SVG content.
assert.equal(fileIconFor('<img onerror="alert(1)">.unknown'), fileIconFor('unknown.extension'));
assert.equal(fileIconFor(null), fileIconFor(''));
assert.notEqual(fileIconFor('package.json'), fileIconFor('package-lock.json'));
assert.notEqual(fileIconFor('tsconfig.json'), fileIconFor('tsconfig.tsbuildinfo'));
console.log(`PASS ${Object.keys(cases).length} file icon mappings, special-name precedence, paths, casing, fallback and static SVG safety`);
