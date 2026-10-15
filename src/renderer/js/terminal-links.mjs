// Xterm uses cell coordinates, which differ from string offsets for Chinese
// characters. Keep a position for each character, including wrapped URL rows.
export function createTerminalLinkProvider(term, activate) {
  return {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      let first = y - 1, last = first;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
      while (buffer.getLine(last + 1)?.isWrapped) last++;
      let text = '';
      const positions = [];
      for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row);
        if (!line) { callback(undefined); return; }
        for (let col = 0; col < line.length; col++) {
          const cell = line.getCell(col);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          text += chars;
          for (let i = 0; i < chars.length; i++) positions.push({ x: col + 1, y: row + 1, width: cell.getWidth() });
        }
      }
      const links = [];
      for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
        let url = match[0].replace(/[.,;!?，。；！？]+$/, '');
        for (const [close, open] of [[')', '('], [']', '['], ['}', '{']]) {
          while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
        }
        try { new URL(url); } catch { continue; }
        const start = positions[match.index], end = positions[match.index + url.length - 1];
        if (!start || !end || y < start.y || y > end.y) continue;
        links.push({ text: url, range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } }, activate });
      }
      callback(links);
    },
  };
}
