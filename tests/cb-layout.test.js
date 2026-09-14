import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExport } from '../js/cb-layout.js';
import { readPage } from '../js/cb-pdf.js';
import { findSkill } from '../js/taxonomy.js';

// ---- synthetic pages laid out like a College Board export (original text, not College Board content) ----

const CHAR_W = 4.6;
const SPACE = 2.2;

// Words of `text` starting at x on baseline y. "~" inside a word becomes a space within that one item.
function words(x, y, text, h = 9) {
  const out = [];
  let cx = x;
  for (const raw of text.split(' ')) {
    const str = raw.replace(/~/g, ' ');
    out.push({ str, x: cx, y, w: str.length * CHAR_W, h });
    cx += str.length * CHAR_W + SPACE;
  }
  return out;
}

const TABLE_BOX = { x0: 18, y0: 678, x1: 594, y1: 742 };
const page = (lines, boxes = []) => ({ view: [0, 0, 612, 792], words: lines.flat(), boxes: [TABLE_BOX, ...boxes] });

function top(id, { test = 'Reading and Writing', domain = 'Information and Ideas', skill = 'Central Ideas and Details', difficulty = 'Medium' } = {}) {
  return [
    words(18, 759, `Question ID: ${id}`, 1),
    words(25, 727, 'Assessment'),
    [{ str: 'T', x: 140, y: 727, w: 5, h: 9 }, { str: 'est', x: 144.6, y: 727, w: 13, h: 9 }], // kerned apart
    words(255, 727, 'Domain'), words(369, 727, 'Skill'), words(484, 727, 'Difficulty'),
    [{ str: 'SA', x: 25, y: 701, w: 10, h: 9 }, { str: 'T', x: 34.5, y: 701, w: 5, h: 9 }],
    // Long values wrap within their column, as in real exports; "|" marks the wrap.
    ...[[140, test], [255, domain], [369, skill], [484, difficulty]].flatMap(([x, value]) =>
      value.split('|').map((part, i) => words(x, 701 - i * 11, part))),
    words(18, 656, 'Question', 8),
  ];
}

function readingPage({ id = '0a1b2c3d', meta, boxes, omitD = false } = {}) {
  return page([
    ...top(id, meta),
    words(18, 642, 'Gardeners in the region plant tomatoes early in spring.'),
    words(18, 627, 'Their repor~t explains why the method works.'),
    words(18, 600, 'Which choice best states the main idea of the text?'),
    words(18, 575, 'Answer', 8),
    words(18, 560, 'A. Tomatoes grow best in cold soil.'),
    words(18, 537, 'B. Early planting helps tomatoes'),
    words(29, 523, 'thrive in the region.'),
    words(18, 513 - 10, 'C. Gardeners dislike tomatoes.'),
    omitD ? [] : words(18, 480, 'D. The method rarely works.'),
    words(18, 452, 'Correct Answer: B', 8),
    words(18, 423, 'Rationale', 8),
    words(18, 408, 'Choice B is the best answer.'),
    words(18, 380, 'Choice A is incorrect.'),
  ], boxes);
}

function mathEntryPage({ id = '9f8e7d6c', answer = '3/4, .75', boxes } = {}) {
  return page([
    ...top(id, { test: 'Math', domain: 'Algebra', skill: 'Linear equations in one|variable', difficulty: 'Easy' }),
    words(18, 642, 'A number doubled is 1.5. What is the number?'),
    words(18, 603, `Correct Answer: ${answer}`.trim(), 8),
    words(18, 575, 'Rationale', 8),
    words(18, 560, 'Half of 1.5 is 0.75.'),
  ], boxes);
}

test('reads a text-only reading and writing question', () => {
  const { questions, warnings } = parseExport([readingPage()]);
  assert.deepEqual(warnings, []);
  const [q] = questions;
  assert.equal(q.cbId, '0a1b2c3d');
  assert.equal(q.assessment, 'SAT');
  assert.equal(q.section, 'RW');
  assert.equal(q.domain, 'Information and Ideas');
  assert.equal(q.skill, 'Central Ideas and Details');
  assert.equal(q.difficulty, 'Medium');
  assert.equal(q.prompt.needsImage, false);
  assert.equal(q.prompt.passage, 'Gardeners in the region plant tomatoes early in spring. Their report explains why the method works.');
  assert.equal(q.prompt.stem, 'Which choice best states the main idea of the text?');
  assert.deepEqual(q.choices.map(c => c.text), [
    'Tomatoes grow best in cold soil.',
    'Early planting helps tomatoes thrive in the region.',
    'Gardeners dislike tomatoes.',
    'The method rarely works.',
  ]);
  assert.equal(q.answer, 'B');
  assert.equal(q.rationale.text, 'Choice B is the best answer.\n\nChoice A is incorrect.');
});

test('a drawing inside the question makes that part an image, leaving the rest as text', () => {
  const [q] = parseExport([readingPage({ boxes: [{ x0: 200, y0: 605, x1: 300, y1: 615 }] })]).questions;
  assert.equal(q.prompt.needsImage, true);
  assert.equal(q.prompt.paragraphs, null);
  assert.ok(q.choices.every(c => !c.needsImage));
  assert.equal(q.rationale.needsImage, false);
});

test('a gap left by missing math makes the part an image', () => {
  const p = readingPage();
  p.words = p.words.filter(w => w.y !== 627).concat(words(18, 627, 'The value of'), words(140, 627, 'is positive.'));
  const [q] = parseExport([p]).questions;
  assert.equal(q.prompt.needsImage, true);
});

test('reads typed-in answers, including equivalent forms', () => {
  const [q] = parseExport([mathEntryPage()]).questions;
  assert.equal(q.section, 'MATH');
  assert.equal(q.choices, null);
  assert.deepEqual(q.answer, ['3/4', '.75']);
  assert.equal(q.prompt.stem, 'A number doubled is 1.5. What is the number?');
  assert.equal(q.prompt.passage, null);
  assert.equal(q.answerRegion, null);
});

test('a typed-in answer drawn as math is left for the student to check against the image', () => {
  const [q] = parseExport([mathEntryPage({ answer: '', boxes: [{ x0: 90, y0: 601, x1: 110, y1: 611 }] })]).questions;
  assert.equal(q.answer, null);
  assert.ok(q.answerRegion.spans.length === 1);
});

test('answer choices that cross a page break span both pages', () => {
  const first = page([
    ...top('1234abcd'),
    words(18, 642, 'A short passage about bridges.'),
    words(18, 615, 'Which choice best describes the text?'),
    words(18, 120, 'Answer', 8),
    words(18, 100, 'A. It praises bridges.'),
    words(18, 60, 'B. It describes how bridges'),
  ]);
  const second = page([
    words(18, 764, 'C. It questions bridges.'),
    words(18, 740, 'D. It ignores bridges.'),
    words(18, 700, 'Correct Answer: B', 8),
    words(18, 670, 'Rationale', 8),
    words(18, 655, 'Choice B is the best answer.'),
  ]);
  first.boxes = [TABLE_BOX];
  second.boxes = [];
  const { questions, warnings } = parseExport([first, second]);
  assert.deepEqual(warnings, []);
  const b = questions[0].choices[1];
  assert.deepEqual(b.spans.map(s => s.page), [0, 1]);
  assert.equal(b.text, 'It describes how bridges');
  assert.equal(questions[0].rationale.text, 'Choice B is the best answer.');
});

test('questions that fail validation are skipped with a reason', () => {
  const { questions, warnings } = parseExport([
    readingPage({ id: 'aaaa0001', omitD: true }),
    readingPage({ id: 'aaaa0002', meta: { skill: 'Poetry' } }),
    readingPage({ id: 'aaaa0003' }),
  ]);
  assert.deepEqual(questions.map(q => q.cbId), ['aaaa0003']);
  assert.match(warnings[0], /aaaa0001: answer choice D not found/);
  assert.match(warnings[1], /aaaa0002: unrecognized skill "Poetry"/);
});

test('a PDF that is not an export produces a clear warning', () => {
  const { questions, warnings } = parseExport([page([words(18, 700, 'Weekly newsletter')])], 'news.pdf');
  assert.equal(questions.length, 0);
  assert.match(warnings[0], /news\.pdf: no questions found/);
});

// ---- real exports, if any are present locally (samples/ is never committed) ----

const samplesDir = fileURLToPath(new URL('../samples/', import.meta.url));
const samples = existsSync(samplesDir) ? readdirSync(samplesDir).filter(f => f.toLowerCase().endsWith('.pdf')) : [];

test('parses the local sample exports cleanly', { skip: samples.length ? false : 'no exports in samples/' }, async t => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const file of samples) {
    const loading = pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(samplesDir, file))), verbosity: 0 });
    const doc = await loading.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) pages.push(await readPage(await doc.getPage(n), pdfjs.OPS));
    const { questions, warnings } = parseExport(pages, file);
    assert.deepEqual(warnings, [], `${file} produced warnings`);
    assert.ok(questions.length > 0, `${file} has no questions`);
    assert.equal(new Set(questions.map(q => q.cbId)).size, questions.length, `${file} has duplicate IDs`);

    const tally = { text: 0, image: 0, selfChecked: 0 };
    for (const q of questions) {
      const skill = findSkill(q.skill);
      assert.ok(skill && skill.section === q.section && skill.domain === q.domain, `${q.cbId}: taxonomy`);
      if (q.choices) {
        assert.deepEqual(q.choices.map(c => c.letter), ['A', 'B', 'C', 'D'], `${q.cbId}: choices`);
        assert.ok(['A', 'B', 'C', 'D'].includes(q.answer), `${q.cbId}: answer`);
      } else if (q.answer === null) {
        tally.selfChecked++;
        assert.ok(q.answerRegion.spans.length, `${q.cbId}: answer image`);
      } else {
        assert.ok(q.answer.length && q.answer.every(a => /^-?[\d./]+$/.test(a)), `${q.cbId}: typed answer ${q.answer}`);
      }
      for (const region of [q.prompt, ...(q.choices || []), q.rationale].filter(Boolean)) {
        assert.ok(region.spans.length, `${q.cbId}: region has no area`);
        tally[region.needsImage ? 'image' : 'text']++;
        for (const p of region.paragraphs || []) {
          // Missing math leaves a word followed by a spaced-out punctuation mark ("with ."). The exports
          // do sometimes space punctuation after a number ("radius 2 ?"), so digits are allowed.
          assert.doesNotMatch(p, /[^\d\s]\s[,.;:?!]|\s{2}|\br t\b/, `${q.cbId}: text looks incomplete: "${p}"`);
        }
      }
    }
    t.diagnostic(`${file}: ${questions.length} questions; ${tally.text} text parts, ${tally.image} image parts, ${tally.selfChecked} self-checked answers`);
    await loading.destroy();
  }
});
