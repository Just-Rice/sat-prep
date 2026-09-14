// Imports questions from PDFs exported from the College Board SAT Suite Educator Question Bank.
// Everything runs in the browser; the PDF and its questions never leave the device.
//
// cb-layout.js finds each question's parts. Parts that are plain text are stored as text; parts with
// math, graphs, tables or underlining are cut from the rendered page as images so they stay exact.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { readPage } from './cb-pdf.js';
import { parseExport } from './cb-layout.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const RENDER_SCALE = 2.4;   // canvas pixels per PDF point
const DISPLAY_SCALE = 1.3;  // CSS pixels per PDF point, so the export's 9pt text shows at about 12px
const PADDING = 4;
const SPAN_GAP = 6;         // pixels between the pieces of a region that crosses a page break
const PAGE_CACHE = 3;

export async function importPdf(file, onProgress = () => {}) {
  const loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await loading.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress(`Reading ${file.name}: page ${n} of ${doc.numPages}…`);
      pages.push(await readPage(await doc.getPage(n), pdfjs.OPS));
    }
    const { questions: parsed, warnings } = parseExport(pages, file.name);
    const renderer = createRenderer(doc);
    const questions = [];
    for (const [i, p] of parsed.entries()) {
      onProgress(`Preparing ${file.name}: question ${i + 1} of ${parsed.length}…`);
      try {
        questions.push(await buildQuestion(p, renderer));
      } catch (err) {
        warnings.push(`${file.name}: skipped question ${p.cbId}: ${err.message}`);
      }
    }
    return { questions, warnings };
  } finally {
    await loading.destroy();
  }
}

async function buildQuestion(p, renderer) {
  const q = {
    id: `cb-${p.cbId}`, cbId: p.cbId, source: 'cb-export', assessment: p.assessment,
    section: p.section, domain: p.domain, skill: p.skill, difficulty: p.difficulty,
    answer: p.answer, importedAt: Date.now(),
  };
  if (p.prompt.needsImage) q.promptImage = await renderer.image(p.prompt.spans);
  else Object.assign(q, { passage: p.prompt.passage, stem: p.prompt.stem });

  if (p.choices) {
    q.choices = [];
    for (const c of p.choices) {
      q.choices.push(c.needsImage ? { letter: c.letter, image: await renderer.image(c.spans) } : { letter: c.letter, text: c.text });
    }
  } else {
    q.choices = null;
  }
  if (p.answer === null) q.answerImage = await renderer.image(p.answerRegion.spans);
  if (p.rationale) {
    if (p.rationale.needsImage) q.rationaleImage = await renderer.image(p.rationale.spans);
    else q.rationale = p.rationale.text;
  }
  q.original = await renderer.image(p.original.spans);
  return q;
}

function createRenderer(doc) {
  const pages = new Map();

  function renderPage(index) {
    if (!pages.has(index)) {
      if (pages.size >= PAGE_CACHE) pages.delete(pages.keys().next().value);
      pages.set(index, (async () => {
        const page = await doc.getPage(index + 1);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // The print intent renders without requestAnimationFrame, which browsers pause in background
        // tabs; with the default intent a long import stalls whenever the tab isn't visible.
        await page.render({ canvasContext: ctx, canvas, viewport, intent: 'print' }).promise;
        return { canvas, viewport };
      })());
    }
    return pages.get(index);
  }

  async function crop(span) {
    const { canvas, viewport } = await renderPage(span.page);
    const [ax, ay] = viewport.convertToViewportPoint(span.left, span.top);
    const [bx, by] = viewport.convertToViewportPoint(span.right, span.bottom);
    const x = Math.max(0, Math.floor(Math.min(ax, bx)));
    const y = Math.max(0, Math.floor(Math.min(ay, by)));
    const w = Math.min(canvas.width, Math.ceil(Math.max(ax, bx))) - x;
    const h = Math.min(canvas.height, Math.ceil(Math.max(ay, by))) - y;
    if (w <= 0 || h <= 0) return null;
    const ink = inkBounds(canvas.getContext('2d').getImageData(x, y, w, h));
    return ink && { canvas, sx: x + ink.x, sy: y + ink.y, w: ink.w, h: ink.h };
  }

  async function image(spans) {
    const pieces = [];
    for (const span of spans) {
      const piece = await crop(span);
      if (piece) pieces.push(piece);
    }
    if (!pieces.length) throw new Error('part of the question rendered blank');
    const out = document.createElement('canvas');
    out.width = Math.max(...pieces.map(p => p.w)) + PADDING * 2;
    out.height = pieces.reduce((sum, p) => sum + p.h, 0) + SPAN_GAP * (pieces.length - 1) + PADDING * 2;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    let top = PADDING;
    for (const p of pieces) {
      ctx.drawImage(p.canvas, p.sx, p.sy, p.w, p.h, PADDING, top, p.w, p.h);
      top += p.h + SPAN_GAP;
    }
    const blob = await new Promise(resolve => out.toBlob(resolve, 'image/webp', 0.92));
    if (!blob) throw new Error('could not encode an image');
    const toCss = px => Math.round((px / RENDER_SCALE) * DISPLAY_SCALE);
    return { blob, width: toCss(out.width), height: toCss(out.height) };
  }

  return { image };
}

// Smallest rectangle containing non-white pixels, or null if the area is blank.
function inkBounds({ data, width, height }) {
  const inked = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235;
  };
  const rowInked = y => { for (let x = 0; x < width; x++) if (inked(x, y)) return true; return false; };
  let top = 0;
  let bottom = height - 1;
  while (top <= bottom && !rowInked(top)) top++;
  if (top > bottom) return null;
  while (!rowInked(bottom)) bottom--;
  const colInked = x => { for (let y = top; y <= bottom; y++) if (inked(x, y)) return true; return false; };
  let left = 0;
  let right = width - 1;
  while (!colInked(left)) left++;
  while (!colInked(right)) right--;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
