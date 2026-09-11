import fs from 'node:fs';
import path from 'node:path';

// Both the displayed path and its real target must stay inside the project.
export function isInsideWorkspace(root, target) {
  const within = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  try {
    const base = path.resolve(root), candidate = path.resolve(target);
    return within(base, candidate) && within(fs.realpathSync(base), fs.realpathSync(candidate));
  } catch { return false; }
}
