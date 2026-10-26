// fs.watch uses platform-specific separators. Keep hidden/build trees out of
// notifications before scheduling a renderer rebuild.
export const TREE_IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next',
  '.nuxt', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea']);
export function shouldRefreshTree(filename) {
  const parts = String(filename || '').replace(/\\/g, '/').split('/');
  return parts.some(Boolean) && !parts.some(part => part.startsWith('.') || TREE_IGNORED.has(part));
}
