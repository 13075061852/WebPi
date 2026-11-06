/** Uploaded files use standalone @"absolute path" lines in SDK history. */
export function splitMessageFiles(value) {
  const text = String(value || '');
  const files = [], lines = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
      lines.push(line);
      continue;
    }
    const match = fence ? null : line.match(/^ {0,3}@"((?:[A-Za-z]:[\\/]|\/|\\\\)[^"\r\n]+)"\s*$/);
    const name = match?.[1].split(/[\\/]/).pop();
    if (name) files.push({ path: match[1], name });
    else lines.push(line);
  }
  return { text: files.length ? lines.join('\n').trim() : text, files };
}

