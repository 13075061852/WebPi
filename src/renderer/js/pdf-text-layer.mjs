// Use the installed PDF.js text layout, including RTL, vertical and rotated text.
// The image remains the visual surface; transparent spans provide native selection.
export async function mountPDFTextLayer(page, data) {
  if (!data?.textContent?.items.length) return;
  const { TextLayer } = await import('../../../node_modules/pdfjs-dist/build/pdf.mjs');
  if (!page.isConnected) return;
  const layer = document.createElement('div');
  layer.className = 'pdf-text-layer';
  const { viewport } = data;
  const { pageWidth, pageHeight } = viewport.rawDims;
  const resize = () => {
    const scale = page.clientWidth / viewport.width * viewport.scale;
    layer.style.setProperty('--total-scale-factor', scale);
    layer.style.width = `${pageWidth * scale}px`;
    layer.style.height = `${pageHeight * scale}px`;
  };
  page.appendChild(layer);
  resize();
  const text = new TextLayer({ container: layer, textContentSource: data.textContent, viewport });
  await text.render();
  if (!page.isConnected) return;
  const observer = new ResizeObserver(() => {
    if (!page.isConnected) { observer.disconnect(); return; }
    resize();
  });
  observer.observe(page);
}
