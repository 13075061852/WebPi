// Keep saved window geometry usable when monitors or desktop work areas change.
export function restoreWindowState(saved, displays, primary) {
  const candidate = saved?.bounds;
  const valid = candidate && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(candidate[key])) && candidate.width > 0 && candidate.height > 0;
  let display = primary, overlap = 0;
  if (valid) for (const item of displays) {
    const area = item.workArea;
    const shared = Math.max(0, Math.min(candidate.x + candidate.width, area.x + area.width) - Math.max(candidate.x, area.x)) *
      Math.max(0, Math.min(candidate.y + candidate.height, area.y + area.height) - Math.max(candidate.y, area.y));
    if (shared > overlap) { overlap = shared; display = item; }
  }
  const area = display.workArea;
  const minWidth = Math.min(520, area.width), minHeight = Math.min(720, area.height);
  const width = Math.round(Math.min(area.width, Math.max(minWidth, valid ? candidate.width : 1440)));
  const height = Math.round(Math.min(area.height, Math.max(minHeight, valid ? candidate.height : 900)));
  const x = valid && overlap ? Math.min(area.x + area.width - width, Math.max(area.x, candidate.x)) : area.x + (area.width - width) / 2;
  const y = valid && overlap ? Math.min(area.y + area.height - height, Math.max(area.y, candidate.y)) : area.y + (area.height - height) / 2;
  return { bounds: { x: Math.round(x), y: Math.round(y), width, height }, minWidth, minHeight, maximized: valid && saved.maximized === true };
}
