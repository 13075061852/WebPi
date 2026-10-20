export function createTerminalKeyHandler(term, toast, clipboard = navigator.clipboard) {
  return event => {
    if (event.type !== 'keydown') return true;
    if (event.ctrlKey && !event.altKey && event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) {
      event.preventDefault();
      clipboard.writeText(term.getSelection()).catch(() => toast('复制失败', 'err'));
      return false;
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyV') {
      event.preventDefault();
      clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => toast('粘贴失败', 'err'));
      return false;
    }
    return true;
  };
}
