// Parses PDFs exported from the College Board SAT Suite Educator Question Bank into questions.
//
// Each exported question has the same layout: a "Question ID" heading, a metadata table (assessment,
// test, domain, skill, difficulty), then "Question", "Answer" (multiple choice only), "Correct Answer:"
// and "Rationale" sections. Math, graphs, tables and underlines are drawn as vector graphics or images
// with no text behind them, so any region that contains graphics, or shows the gaps they leave in the
// text, is marked to be rendered as an image cut from the page instead of being read as text.
//
// Input is page layout from cb-pdf.js; nothing here touches PDF.js or the DOM, so it runs in Node tests.

import { findSkill } from './taxonomy.js';

const SECTION_BY_TEST = { Math: 'MATH', 'Reading and Writing': 'RW' };
const DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard']);
const LETTERS = ['A', 'B', 'C', 'D'];
const METADATA_COLUMNS = ['Assessment', 'Test', 'Domain', 'Skill', 'Difficulty'];

const WORD_GAP = 1;              // real spaces are about 2pt wide; kerned pieces of one word touch or overlap
const MISSING_CONTENT_GAP = 6;   // a wider gap inside a line means something drawn sits there
const INDENT_LIMIT = 30;         // lines starting this far in usually follow drawn math
const PARAGRAPH_GAP = 20;        // lines in a paragraph are about 14.5pt apart; paragraphs about 26pt
const PAD = 3;

export function parseExport(pages, sourceName = 'export') {
  const lines = pages.flatMap((page, index) => buildLines(page, index));
  const starts = lines.flatMap((line, i) => (/^Question ID:\s*\S+$/.test(line.text) ? [i] : []));
  const questions = [];
  const warnings = [];
  if (!starts.length) {
    warnings.push(`${sourceName}: no questions found. Is this a PDF exported from the College Board Question Bank?`);
  }
  starts.forEach((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const ctx = { pages, segment: lines.slice(start, end), nextHeader: lines[end] ?? null };
    try {
      questions.push(parseQuestion(ctx));
    } catch (err) {
      warnings.push(`${sourceName}: skipped question ${idOf(lines[start])}: ${err.message}`);
    }
  });
  return { questions, warnings };
}

const idOf = line => line.text.replace(/^Question ID:\s*/, '');

// ---------- lines ----------

function buildLines(page, pageIndex) {
  const rows = [];
  for (const word of page.words) {
    let row = rows.find(r => Math.abs(r.y - word.y) <= 2);
    if (!row) rows.push(row = { y: word.y, words: [] });
    row.words.push(word);
  }
  return rows.sort((a, b) => b.y - a.y).map(row => {
    const tokens = [];
    for (const word of row.words.sort((a, b) => a.x - b.x)) {
      // The exports break every "rt" pair with a space ("repor t"); real spaces never occur inside an item.
      const str = word.str.trim().replace(/([A-Za-zÀ-ÿ])r t/g, '$1rt');
      const last = tokens[tokens.length - 1];
      if (last && word.x - last.xEnd <= WORD_GAP) {
        last.text += str;
        last.xEnd = Math.max(last.xEnd, word.x + word.w);
      } else {
        tokens.push({ text: str, x: word.x, xEnd: word.x + word.w });
      }
    }
    const h = Math.max(8, ...row.words.map(w => w.h));
    return {
      page: pageIndex, y: row.y, top: row.y + h, tokens,
      x: tokens[0].x, xEnd: tokens[tokens.length - 1].xEnd,
      text: tokens.map(t => t.text).join(' '),
    };
  });
}

// ---------- one question ----------

function parseQuestion(ctx) {
  const { segment, pages } = ctx;
  const header = segment[0];
  const margin = header.x;
  const left = margin - 2;
  const find = (from, match) => {
    for (let i = from; i < segment.length; i++) {
      if (Math.abs(segment[i].x - margin) < 4 && match(segment[i].text)) return i;
    }
    return -1;
  };

  const questionIdx = find(1, t => t === 'Question');
  if (questionIdx < 0) throw new Error('no "Question" section');
  const correctIdx = find(questionIdx + 1, t => /^Correct Answer:/.test(t));
  if (correctIdx < 0) throw new Error('no "Correct Answer" line');
  const answerIdx = find(questionIdx + 1, t => t === 'Answer');
  const hasChoices = answerIdx >= 0 && answerIdx < correctIdx;
  const rationaleIdx = find(correctIdx + 1, t => t === 'Rationale');

  const meta = readMetadata(segment.slice(1, questionIdx));
  const section = SECTION_BY_TEST[meta.Test];
  if (!section) throw new Error(`unsupported test "${meta.Test}"`);
  const skill = findSkill(meta.Skill);
  if (!skill || skill.section !== section) throw new Error(`unrecognized skill "${meta.Skill}"`);
  if (skill.domain !== meta.Domain) throw new Error(`skill "${meta.Skill}" is not part of domain "${meta.Domain}"`);
  if (!DIFFICULTIES.has(meta.Difficulty)) throw new Error(`unrecognized difficulty "${meta.Difficulty}"`);

  const below = line => ({ page: line.page, y: line.y - PAD });
  const above = line => ({ page: line.page, y: line.top + PAD });
  const correctLine = segment[correctIdx];

  const prompt = makeRegion(ctx, below(segment[questionIdx]), above(segment[hasChoices ? answerIdx : correctIdx]), left);
  if (prompt.empty) throw new Error('the question text is empty');
  if (!prompt.needsImage) {
    const ps = prompt.paragraphs;
    const split = section === 'RW' && ps.length > 1;
    prompt.passage = split ? ps.slice(0, -1).join('\n\n') : null;
    prompt.stem = split ? ps[ps.length - 1] : ps.join('\n\n');
  }

  let choices = null;
  if (hasChoices) {
    const starts = [];
    for (const letter of LETTERS) {
      const i = find((starts[starts.length - 1] ?? answerIdx) + 1, t => t === `${letter}.` || t.startsWith(`${letter}. `));
      if (i < 0 || i > correctIdx) throw new Error(`answer choice ${letter} not found`);
      starts.push(i);
    }
    choices = starts.map((i, k) => {
      const line = segment[i];
      const end = above(segment[starts[k + 1] ?? correctIdx]);
      const region = makeRegion(ctx, above(line), end, line.tokens[0].xEnd + 1.5);
      if (region.empty) throw new Error(`answer choice ${LETTERS[k]} is empty`);
      if (!region.needsImage) region.text = region.paragraphs.join(' ');
      return { letter: LETTERS[k], ...region };
    });
  }

  const answerLabel = correctLine.tokens.findIndex(t => t.text === 'Answer:');
  const answerText = correctLine.tokens.slice(answerLabel + 1).map(t => t.text).join(' ').trim();
  const answerRegion = makeRegion(ctx, above(correctLine), { page: correctLine.page, y: correctLine.y - 4 },
    correctLine.tokens[answerLabel].xEnd + 1);
  let answer;
  if (hasChoices) {
    if (!LETTERS.includes(answerText)) throw new Error(`unexpected correct answer "${answerText}"`);
    answer = answerText;
  } else if (answerRegion.needsImage || !answerText) {
    answer = null; // drawn as math: the student compares against the image instead
  } else {
    answer = answerText.split(/,\s+|\s+or\s+/).map(a => a.trim()).filter(Boolean);
  }

  let rationale = null;
  if (rationaleIdx >= 0) {
    const label = segment[rationaleIdx];
    const region = makeRegion(ctx, below(label), segmentEnd(ctx, label), left);
    if (!region.empty) {
      if (!region.needsImage) region.text = region.paragraphs.join('\n\n');
      rationale = region;
    }
  }

  return {
    cbId: idOf(header), assessment: meta.Assessment, section, domain: skill.domain, skill: skill.name,
    difficulty: meta.Difficulty, prompt, choices, answer,
    answerRegion: answer === null ? answerRegion : null,
    rationale,
    original: { spans: spansBetween(pages, below(segment[questionIdx]), above(correctLine), left) },
  };
}

function readMetadata(lines) {
  const headerIdx = lines.findIndex(l => l.text.startsWith('Assessment'));
  if (headerIdx < 0) throw new Error('metadata table not found');
  const columns = METADATA_COLUMNS.map(name => {
    const token = lines[headerIdx].tokens.find(t => t.text === name);
    if (!token) throw new Error(`metadata column "${name}" not found`);
    return { name, x: token.x, parts: [] };
  });
  for (const line of lines.slice(headerIdx + 1)) {
    for (const token of line.tokens) {
      const column = columns.filter(c => c.x <= token.x + 3).pop();
      column?.parts.push(token.text);
    }
  }
  return Object.fromEntries(columns.map(c => [c.name, c.parts.join(' ').trim()]));
}

// ---------- regions ----------

function spansBetween(pages, start, end, left) {
  const spans = [];
  for (let p = start.page; p <= end.page; p++) {
    const view = pages[p].view;
    spans.push({
      page: p, left, right: view[2] - 14,
      top: p === start.page ? start.y : view[3] - 6,
      bottom: p === end.page ? end.y : view[1] + 6,
    });
  }
  return spans.filter(s => s.top > s.bottom);
}

const overlaps = (b, s) => b.x1 > s.left + 0.5 && b.x0 < s.right - 0.5 && b.y1 > s.bottom + 0.5 && b.y0 < s.top - 0.5;

function makeRegion({ pages, segment }, start, end, left) {
  const spans = spansBetween(pages, start, end, left);
  const lines = segment
    .filter(l => spans.some(s => s.page === l.page && l.y < s.top && l.y > s.bottom))
    .map(l => ({ ...l, tokens: l.tokens.filter(t => t.xEnd > left + 1) }))
    .filter(l => l.tokens.length);
  const graphics = spans.some(s => pages[s.page].boxes.some(b => overlaps(b, s)));
  const gaps = lines.some(l => l.tokens[0].x > left + INDENT_LIMIT
    || l.tokens.some((t, i) => i > 0 && t.x - l.tokens[i - 1].xEnd > MISSING_CONTENT_GAP));
  const needsImage = graphics || gaps;
  return {
    spans,
    needsImage,
    empty: !graphics && !lines.length,
    paragraphs: needsImage ? null : paragraphs(lines, pages),
  };
}

function paragraphs(lines, pages) {
  const out = [];
  let prev = null;
  for (const line of lines) {
    const text = line.tokens.map(t => t.text).join(' ');
    const newParagraph = !prev || (line.page === prev.page
      ? prev.y - line.y > PARAGRAPH_GAP
      : prev.xEnd < pages[prev.page].view[2] - 80); // across a page break, a short last line ends a paragraph
    if (newParagraph) out.push(text);
    else out[out.length - 1] += /[-—]$/.test(out[out.length - 1]) ? text : ` ${text}`;
    prev = line;
  }
  return out;
}

// The bottom of a question's last content: its last text line or anything drawn below it.
function segmentEnd({ pages, segment, nextHeader }, fromLine) {
  const last = segment[segment.length - 1];
  const floor = nextHeader && nextHeader.page === last.page ? nextHeader.top + PAD : -Infinity;
  const ceiling = fromLine.page === last.page ? fromLine.y : Infinity;
  let bottom = last.y - 4;
  for (const b of pages[last.page].boxes) {
    if (b.y1 > floor && b.y1 < ceiling && b.y0 - 2 < bottom) bottom = b.y0 - 2;
  }
  return { page: last.page, y: Math.max(bottom, floor, pages[last.page].view[1] + 6) };
}
