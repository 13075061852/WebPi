// Watchers such as `node --watch` emit RIS (ESC c) on restart. xterm's
// default reset destroys the entire normal buffer, including scrollback.
// ConPTY follows RIS with a blank-screen repaint, so ignoring RIS alone still
// overwrites the old output. Move the used viewport into scrollback first, then
// let ConPTY repaint a fresh screen. Full-screen apps keep native reset behavior.
export function preserveTerminalHistory(term) {
  const normal = () => term.buffer.active.type === 'normal';
  const erase = term.parser.registerCsiHandler({ final: 'J' }, params => normal() && params.length === 1 && params[0] === 3);
  let state = 'ground', busy = false, disposed = false;
  const queue = [];
  // Only hold an incomplete ESC. OSC/DCS payloads pass through untouched, even
  // when they contain ESC c. All other terminal controls retain xterm semantics.
  function split(data) {
    const parts = []; let text = '';
    for (const ch of data) {
      if (state === 'escape') {
        if (ch === 'c') { if (text) parts.push(text); text = ''; parts.push(null); state = 'ground'; }
        else if (ch === '\x1b') text += '\x1b';
        else { text += '\x1b' + ch; state = 'P]X^_'.includes(ch) ? 'string' : 'ground'; }
      } else if (state === 'string' || state === 'string-escape') {
        text += ch;
        if (ch === '\x07' || ch === '\x18' || ch === '\x1a' || (state === 'string-escape' && ch === '\\')) state = 'ground';
        else state = ch === '\x1b' ? 'string-escape' : 'string';
      } else if (ch === '\x1b') state = 'escape';
      else text += ch;
    }
    if (text) parts.push(text);
    return parts;
  }
  function drain() {
    if (disposed || busy || !queue.length) return;
    busy = true;
    const { data, done } = queue.shift(), parts = split(data);
    function next() {
      if (disposed || !parts.length) { busy = false; done?.(); drain(); return; }
      let part = parts.shift();
      if (part === null) {
        if (normal()) {
          // Compute after preceding writes have parsed, including writes in the
          // same IPC chunk. Avoid adding a whole screen of empty history rows.
          const used = term.buffer.active.cursorY + 1;
          part = `\x1b[r\x1b[${term.rows};1H` + '\r\n'.repeat(used) + '\x1b[H\x1b[0m';
        } else part = '\x1bc';
      }
      term.write(part, next);
    }
    next();
  }
  return {
    write(data, done) { if (disposed) { done?.(); return; } queue.push({ data, done }); drain(); },
    dispose() { disposed = true; erase.dispose(); for (const item of queue.splice(0)) item.done?.(); },
  };
}
