// Draws the page into a canvas, for saving a screenshot. Browsers can't capture
// their own page, so this repaints what this dashboard uses: boxes with
// backgrounds, borders and rounded corners, single-style text, inline SVG
// (with its CSS applied) and canvases, including the 3D view.

const SVG_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linejoin', 'stroke-linecap', 'opacity', 'display', 'visibility',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'font-variant-numeric',
];

const px = v => parseFloat(v) || 0;
const visibleColor = c => c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c);

// root: element to capture. substitutes: Map of canvas -> canvas to draw instead
// (a WebGL canvas must be copied right after it renders).
export async function capturePage(root, { substitutes = new Map(), scale = window.devicePixelRatio || 1 } = {}) {
  const r = root.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(r.width * scale);
  canvas.height = Math.round(r.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-r.left, -r.top);
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(r.left, r.top, r.width, r.height);
  await drawElement(ctx, root, substitutes);
  return canvas;
}

function roundRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

// Painting order within a parent: normal flow first, then positioned elements
// by z-index, as the browser stacks them (close enough for this page).
function layer(el) {
  if (el.nodeType !== Node.ELEMENT_NODE) return 0;
  const cs = getComputedStyle(el);
  if (cs.position === 'static') return 0;
  return 1 + (cs.zIndex === 'auto' ? 0 : Number(cs.zIndex));
}

async function drawElement(ctx, el, substitutes) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || el.tagName === 'DIALOG' || el.tagName === 'SCRIPT') return;
  const r = el.getBoundingClientRect();
  ctx.save();
  ctx.globalAlpha *= Number(cs.opacity);
  const radius = px(cs.borderTopLeftRadius);

  if (visibleColor(cs.backgroundColor)) {
    ctx.fillStyle = cs.backgroundColor;
    roundRect(ctx, r.left, r.top, r.width, r.height, radius);
    ctx.fill();
  }
  const bw = px(cs.borderTopWidth);
  if (bw > 0 && cs.borderTopStyle !== 'none' && visibleColor(cs.borderTopColor)) {
    ctx.strokeStyle = cs.borderTopColor;
    ctx.lineWidth = bw;
    roundRect(ctx, r.left + bw / 2, r.top + bw / 2, r.width - bw, r.height - bw, Math.max(0, radius - bw / 2));
    ctx.stroke();
  }
  if (cs.overflow !== 'visible') {
    roundRect(ctx, r.left, r.top, r.width, r.height, radius);
    ctx.clip();
  }

  if (el.tagName === 'CANVAS') {
    if (cs.filter && cs.filter !== 'none') ctx.filter = cs.filter;
    const src = substitutes.get(el) || el;
    if (src.width && src.height) ctx.drawImage(src, r.left, r.top, r.width, r.height);
  } else if (el instanceof SVGSVGElement) {
    await drawSvg(ctx, el, r);
  } else {
    const children = [...el.childNodes].map((node, i) => ({ node, i, layer: layer(node) }));
    children.sort((a, b) => a.layer - b.layer || a.i - b.i);
    for (const { node } of children) {
      if (node.nodeType === Node.TEXT_NODE) drawText(ctx, node, cs);
      else if (node.nodeType === Node.ELEMENT_NODE) await drawElement(ctx, node, substitutes);
    }
  }
  ctx.restore();
}

function drawText(ctx, node, cs) {
  const text = node.textContent.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter(q => q.width > 0);
  if (!rects.length) return;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.fillStyle = cs.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? px(cs.fontSize) * 0.8;
  const descent = m.fontBoundingBoxDescent ?? px(cs.fontSize) * 0.2;
  const baseline = q => q.top + (q.height - ascent - descent) / 2 + ascent;
  if (rects.length === 1) {
    ctx.fillText(text, rects[0].left, baseline(rects[0]));
    return;
  }
  // Wrapped text: fill the line boxes word by word.
  const words = text.split(' ');
  let w = 0;
  for (const q of rects) {
    let line = '';
    while (w < words.length) {
      const next = line ? `${line} ${words[w]}` : words[w];
      if (line && ctx.measureText(next).width > q.width + 1) break;
      line = next;
      w++;
    }
    ctx.fillText(line, q.left, baseline(q));
  }
}

// Inline SVG keeps its look from the page's stylesheet, which an <img> of it
// wouldn't see, so the computed styles are copied onto a clone first.
async function drawSvg(ctx, svgEl, r) {
  const clone = svgEl.cloneNode(true);
  const src = [svgEl, ...svgEl.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((s, i) => {
    const cs = getComputedStyle(s);
    dst[i].setAttribute('style', SVG_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  });
  clone.setAttribute('width', r.width);
  clone.setAttribute('height', r.height);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  try {
    await img.decode();
    ctx.drawImage(img, r.left, r.top, r.width, r.height);
  } catch { /* leave it out rather than fail the whole picture */ }
}
