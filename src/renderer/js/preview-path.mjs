// Resolve tool-relative paths before creating preview URLs or persisting selection.
// The main process remains responsible for realpath/project-boundary validation.
export function resolvePreviewPath(value, cwd) {
  if (typeof value !== 'string' || !value) return null;
  const file = value.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(file) || file.startsWith('/')) return file;
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) || !cwd) return null;
  return String(cwd).replace(/\\/g, '/').replace(/\/$/, '') + '/' + file;
}
