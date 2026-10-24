// Drafts stay attached to the absolute file path while previews/conversations change.
export function createFileEditor({ api, body, status, notify }) {
  const drafts = new Map();
  let file = null, generation = 0, active = null;
  const key = p => p.replace(/\\/g, '/');
  const dirty = draft => draft.content !== draft.original;
  function update() {
    const editing = !!active;
    status.hidden = !editing;
    if (editing) status.textContent = active.saving ? '保存中…' : dirty(active) ? '未保存' : '';
  }
  function detach() { if (active && !dirty(active) && !active.saving) drafts.delete(key(active.path)); generation++; file = null; active = null; update(); }
  function select(path, eligible = true) {
    if (active && !dirty(active) && !active.saving) drafts.delete(key(active.path));
    generation++; active = null; file = eligible ? path : null; update();
    return generation;
  }
  function mount(draft) {
    active = draft;
    const shell = document.createElement('div'); shell.className = 'file-editor';
    const lines = document.createElement('div'); lines.className = 'file-editor-lines'; lines.setAttribute('aria-hidden', 'true');
    const input = document.createElement('textarea'); input.className = 'file-editor-input';
    input.setAttribute('aria-label', '编辑文件内容'); input.spellcheck = false; input.wrap = 'off';
    input.value = draft.content; input.autocapitalize = 'off'; input.autocomplete = 'off';
    const count = () => { lines.textContent = Array.from({ length: input.value.split('\n').length }, (_, i) => i + 1).join('\n'); };
    count();
    input.addEventListener('input', () => {
      draft.content = input.value;
      count(); update();
    });
    input.addEventListener('scroll', () => { lines.scrollTop = input.scrollTop; });
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault(); input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input'));
      }
    });
    shell.append(lines, input); body.replaceChildren(shell); update();
  }
  async function open({ quiet = false } = {}) {
    if (!file) return false;
    const target = file, request = generation;
    let draft = drafts.get(key(target));
    if (!draft) {
      try {
        const result = await api.readEditableFile(target);
        if (!result?.ok) throw Error(result?.error || '无法编辑文件');
        const raw = result.data.content;
        // Textarea uses LF internally; restore the original line-ending convention on save.
        draft = { original: raw.replace(/\r\n/g, '\n'), content: raw.replace(/\r\n/g, '\n'),
          eol: raw.includes('\r\n') ? '\r\n' : '\n', revision: result.data.revision, path: target, saving: false };
      } catch (error) { if (!quiet && request === generation) notify(error.message, 'err'); return false; }
    }
    if (request !== generation || target !== file) return false;
    drafts.set(key(target), draft);
    mount(draft); return true;
  }
  async function saveDraft() {
    const draft = active;
    if (!draft || draft.saving || !dirty(draft)) return;
    const sent = draft.content;
    draft.saving = true; update();
    try {
      const result = await api.saveEditableFile({ path: draft.path, revision: draft.revision,
        content: draft.eol === '\r\n' ? sent.replace(/\n/g, '\r\n') : sent });
      if (!result?.ok) throw Error(result?.error || '保存失败');
      draft.revision = result.data.revision; draft.original = sent;
    } catch (error) { notify(error.message, 'err'); }
    finally { draft.saving = false; update(); }
  }
  document.addEventListener('keydown', event => {
    if (active && body.contains(event.target) && body.querySelector('.file-editor-input')?.checkVisibility({ visibilityProperty: true }) && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.isComposing) {
      event.preventDefault(); void saveDraft();
    }
  });
  window.addEventListener('beforeunload', event => {
    if ([...drafts.values()].some(draft => dirty(draft) || draft.saving) && !window.confirm('有文件尚未保存，仍要退出？')) {
      event.preventDefault(); event.returnValue = false;
    }
  });
  update();
  return { select, detach, open, hasDraft: path => drafts.has(key(path)), draftContent: path => drafts.get(key(path))?.content };
}
