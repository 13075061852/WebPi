// Apply only inside the bundled Pi command process. Its npm/Git helpers must
// inherit the desktop's hidden console while retaining their captured output.
if (process.platform === 'win32') {
  const childProcess = require('node:child_process');
  for (const name of ['spawn', 'spawnSync']) {
    const original = childProcess[name];
    childProcess[name] = function (command, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      return original.call(this, command, args, { ...options, windowsHide: true });
    };
  }
  require('node:module').syncBuiltinESMExports();
}
