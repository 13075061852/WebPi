(function setPreviewMotion(paused) {
  const key = Symbol.for('pi-halo.preview-motion');
  if (!paused && !window[key]) return;
  if (!window[key]) {
    const raf = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const frames = new Map();
    const animations = new Set();
    let stopped = false, resizeFrame = null;
    function deliver(id, time) {
      const frame = frames.get(id);
      if (!frame) return;
      frame.nativeId = null;
      if (stopped) return;
      frames.delete(id);
      Reflect.apply(frame.callback, window, [time]);
    }
    window.requestAnimationFrame = callback => {
      if (typeof callback !== 'function') return raf(callback);
      const id = raf(time => deliver(id, time));
      frames.set(id, { callback, nativeId: stopped ? null : id });
      if (stopped) cancel(id);
      return id;
    };
    window.cancelAnimationFrame = id => {
      const frame = frames.get(id);
      cancel(frame?.nativeId ?? id);
      frames.delete(id);
    };
    // A resize can clear a canvas. Paint the new dimensions once while paused,
    // preserving callbacks scheduled by that frame for the eventual resume.
    window.addEventListener('resize', () => {
      if (!stopped || resizeFrame !== null) return;
      resizeFrame = raf(time => {
        resizeFrame = null;
        if (!stopped) return;
        for (const [id, frame] of [...frames]) {
          if (frames.get(id) !== frame || frame.nativeId !== null) continue;
          frames.delete(id);
          try { Reflect.apply(frame.callback, window, [time]); } catch (error) { setTimeout(() => { throw error; }); }
        }
      });
    });
    window[key] = next => {
      stopped = next;
      if (stopped) {
        for (const frame of frames.values()) {
          if (frame.nativeId !== null) cancel(frame.nativeId);
          frame.nativeId = null;
        }
        for (const animation of document.getAnimations()) {
          if (animation.playState === 'running') { animations.add(animation); animation.pause(); }
        }
      } else {
        if (resizeFrame !== null) { cancel(resizeFrame); resizeFrame = null; }
        for (const [id, frame] of frames) {
          if (frame.nativeId === null) frame.nativeId = raf(time => deliver(id, time));
        }
        for (const animation of animations) if (animation.playState === 'paused') animation.play();
        animations.clear();
      }
    };
  }
  window[key](paused);
})
