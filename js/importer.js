// Imports questions from PDFs exported from the College Board SAT Suite Educator Question Bank.
// Parsing runs entirely in the browser; the PDF and its questions never leave the device.
//
// The export layout still needs to be confirmed against a real sample export, so parseExport is a
// placeholder until then. Text extraction below is format-independent.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// Returns one entry per page: the text lines in reading order.
export async function extractPages(file) {
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const lines = new Map();
    for (const item of items) {
      if (!item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const key = [...lines.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({ x: item.transform[4], str: item.str });
    }
    pages.push([...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map(p => p.str).join(' ').replace(/\s+/g, ' ').trim()));
  }
  return pages;
}

export async function importPdf(file) {
  const pages = await extractPages(file);
  return parseExport(pages, file.name);
}

function parseExport(pages, fileName) {
  console.info(`[importer] ${fileName}: ${pages.length} pages extracted`, pages);
  return {
    questions: [],
    warnings: [`${fileName}: the College Board export format isn't supported yet. Add a sample export to samples/ so the parser can be built against it.`],
  };
}
