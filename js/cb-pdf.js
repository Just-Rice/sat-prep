// Reads the layout of one PDF.js page: positioned words, plus the bounding boxes of everything painted
// as graphics (paths and images). Shared by the browser importer and the Node tests.

const IDENTITY = [1, 0, 0, 1, 0, 0];

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

function transformBox(m, x0, y0, x1, y1) {
  const xs = [], ys = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Coordinates are PDF user space (origin bottom-left, y up), matching PDF.js text positions.
export async function readPage(page, OPS) {
  const [text, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const words = text.items
    .filter(item => item.str.trim())
    .map(item => ({ str: item.str, x: item.transform[4], y: item.transform[5], w: item.width, h: item.height }));
  return { view: [...page.view], words, boxes: paintedBoxes(operators, OPS, page.view) };
}

function paintedBoxes({ fnArray, argsArray }, OPS, view) {
  // Anything whose extent isn't tracked counts as covering the whole page, so no region is misread as
  // plain text when it actually contains a drawing.
  const wholePage = { x0: view[0], y0: view[1], x1: view[2], y1: view[3] };
  const boxes = [];
  const stack = [];
  let ctm = IDENTITY;

  for (let i = 0; i < fnArray.length; i++) {
    const args = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        ctm = multiply(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args?.[0]) ctm = multiply(ctm, args[0]);
        break;
      case OPS.beginGroup:
        stack.push(ctm);
        if (args?.[0]?.matrix) ctm = multiply(ctm, args[0].matrix);
        break;
      case OPS.paintFormXObjectEnd:
      case OPS.endGroup:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.constructPath: {
        const [op, , minMax] = args;
        if (op === OPS.endPath) break; // a clipping path: nothing is painted
        boxes.push(minMax ? transformBox(ctm, minMax[0], minMax[1], minMax[2], minMax[3]) : wholePage);
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
        boxes.push(transformBox(ctm, 0, 0, 1, 1)); // images are drawn into the unit square
        break;
      case OPS.shadingFill:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat:
      case OPS.paintImageMaskXObjectGroup:
        boxes.push(wholePage);
        break;
    }
  }
  return boxes;
}
