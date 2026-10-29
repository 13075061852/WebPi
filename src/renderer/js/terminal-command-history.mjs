// CMD marks each prompt with OSC 9;9 (cwd). Read the command that CMD actually
// echoed, so editing/completion and pasted input are recorded without guessing
// keystrokes or collecting input sent to a running child program.
export function createTerminalCommandHistory(term, { commands = [], remember, write, replaying = false, migrate = false }) {
  const history = commands.filter(command => typeof command === 'string' && command.trim());
  const directories = new Set();
  // ConPTY keeps physical wrapped rows during resize. Newly exposed cells are
  // empty padding, not typed spaces; translateToString(false) invents spaces
  // there and can corrupt a recalled draft or prevent an echo acknowledgement.
  const rowText = (row, start = 0) => {
    let text = '';
    for (let cell = start; row && cell < row.length; cell++) text += row.getCell(cell)?.getChars() || '';
    return text;
  };
  let marker, column = 0, ready = false, submitted = false, pendingPrompt = false, index = history.length, draft = '', replacing = null, queuedInput = '';
  const add = command => {
    command = command.trim();
    if (command && command !== history.at(-1)) { history.push(command); remember(command); }
  };
  function line() {
    const buffer = term.buffer.normal;
    // A ConPTY resize repaint may move the prompt after xterm's resize event.
    // Re-find it while editing/recalling instead of trusting the old marker.
    if (ready || replacing) {
      const end = buffer.baseY + buffer.cursorY, rows = [];
      let text = '';
      for (let y = Math.max(0, end - 512); y <= end; y++) {
        const row = buffer.getLine(y), value = rowText(row);
        rows.push({ y, row, start: text.length, length: value.length }); text += value;
      }
      let found = -1;
      for (const cwd of directories) { const at = text.lastIndexOf(cwd + '>'); if (at >= 0) found = Math.max(found, at + cwd.length + 1); }
      const row = rows.findLast(row => row.start < found);
      if (row) {
        let chars = 0, cell = 0;
        while (cell < term.cols && chars < found - row.start) { chars += row.row.getCell(cell)?.getChars().length || 0; cell++; }
        marker?.dispose(); marker = term.registerMarker(row.y - end); column = cell;
      }
    }
    if (!marker || marker.isDisposed || marker.line < 0) return { text: '', end: -1 };
    let end = marker.line;
    let text = rowText(buffer.getLine(end), column);
    while (buffer.getLine(end + 1)?.isWrapped) text += rowText(buffer.getLine(++end));
    return { text: text.trimEnd(), end };
  }
  function commit() {
    if (!marker || (replaying && !migrate)) return;
    const command = line().text.trim();
    add(command);
    submitted = false;
  }
  function clear() { marker?.dispose(); marker = null; ready = false; submitted = false; index = history.length; }
  function input(data) {
    if (replacing) { queuedInput += data; return false; }
    if (ready && !replaying) {
      line();
      if (/[\r\n]/.test(data)) { submitted = true; ready = false; }
      else if (data.includes('\x03')) { ready = false; submitted = false; }
    }
    return true;
  }
  function replace(target) {
    if (replacing) { replacing.target = target; return; }
    if (line().text === target) return;
    replacing = { target, phase: line().text ? 'clear' : 'write', sent: target };
    // CMD discards other input queued with Escape. Wait for its cleared-line
    // repaint before sending the recalled text, instead of using a time delay.
    write(replacing.phase === 'clear' ? '\x1b' : target);
  }
  const prompt = term.parser.registerOscHandler(9, data => {
    if (!data.startsWith('9;') || term.buffer.active.type !== 'normal') return false;
    directories.add(data.slice(2)); pendingPrompt = true;
    return false; // Preserve other consumers of the directory notification.
  });
  const parsed = term.onWriteParsed(() => {
    if (replaying || term.buffer.active.type !== 'normal') return;
    const buffer = term.buffer.normal, command = line();
    if (replacing) {
      if (replacing.phase === 'clear' && !command.text) {
        replacing.phase = 'write'; replacing.sent = replacing.target;
        if (replacing.sent) { write(replacing.sent); return; }
      } else if (replacing.phase !== 'write' || command.text !== replacing.sent) return;
      const target = replacing.target; replacing = null;
      if (command.text !== target) { replace(target); return; }
      if (queuedInput) { const data = queuedInput; queuedInput = ''; input(data); write(data); }
    }
    // Capture long-running commands once their echoed input has been submitted,
    // without waiting for another prompt (which may not arrive before shutdown).
    if (submitted && marker && buffer.baseY + buffer.cursorY > command.end) commit();
    // ConPTY can forward OSC before flushing its screen diff. Anchor only after
    // the printable prompt is painted, rather than at the OSC's stream offset.
    if (pendingPrompt && buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true, 0, buffer.cursorX).endsWith('>')) {
      clear(); marker = term.registerMarker(0); column = buffer.cursorX;
      ready = true; pendingPrompt = false; index = history.length;
    }
  });
  return {
    input,
    key(event) {
      if (event.type !== 'keydown' || !ready || replaying || term.buffer.active.type !== 'normal'
          || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !history.length) return true;
      event.preventDefault();
      if (index === history.length) draft = line().text;
      index = Math.max(0, Math.min(history.length, index + (event.key === 'ArrowUp' ? -1 : 1)));
      replace(index === history.length ? draft : history[index]);
      return false;
    },
    resume() {
      if (replaying && migrate) {
        const prompts = [], buffer = term.buffer.normal;
        for (let y = 0; y < buffer.length; y++) {
          let text = rowText(buffer.getLine(y));
          while (buffer.getLine(y + 1)?.isWrapped) text += rowText(buffer.getLine(++y));
          for (const cwd of directories) if (text.startsWith(cwd + '>')) { prompts.push(text.slice(cwd.length + 1).trim()); break; }
        }
        // The last prompt may contain an unsubmitted draft.
        prompts.slice(0, -1).filter(Boolean).forEach(add);
      }
      replaying = false; pendingPrompt = false; clear();
    },
    dispose() { clear(); prompt.dispose(); parsed.dispose(); },
  };
}
