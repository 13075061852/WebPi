// Animate only the live content pane: no screenshots, clones or layout changes.
export function createConversationMotion({ reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches } = {}) {
  let animation;
  const cancel = () => { animation?.cancel(); animation = null; };
  const reveal = element => {
    cancel();
    if (!element || reduced()) return;
    animation = element.animate([
      { opacity: 0.65, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
    const current = animation;
    current.finished.then(() => {
      if (animation === current) { current.cancel(); animation = null; }
    }, () => {});
  };
  return { cancel, reveal };
}
