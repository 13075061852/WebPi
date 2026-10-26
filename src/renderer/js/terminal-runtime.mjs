let loading, stylesheet;
function asset(tag, url) {
  return new Promise((resolve, reject) => {
    const node = document.createElement(tag);
    if (tag === 'link') { node.rel = 'stylesheet'; node.href = url; }
    else node.src = url;
    node.onload = () => resolve();
    node.onerror = () => { node.remove(); reject(Error('终端组件加载失败，请重试')); };
    document.head.append(node);
  });
}
export function loadTerminalRuntime() {
  if (!loading) loading = (async () => {
    const css = stylesheet ||= asset('link', new URL('../vendor/xterm.css', import.meta.url).href)
      .catch(error => { stylesheet = null; throw error; });
    const scripts = (async () => {
      if (!window.Terminal) await asset('script', new URL('../vendor/xterm.js', import.meta.url).href);
      if (!window.FitAddon) await asset('script', new URL('../vendor/addon-fit.js', import.meta.url).href);
    })();
    await Promise.all([css, scripts]);
  })().catch(error => { loading = null; throw error; });
  return loading;
}
