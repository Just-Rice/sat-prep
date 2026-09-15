import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMS, EXAM_IDS, examOfQuestion, scoredSections, skillsOf, totalScore } from '../js/exams.js';
import { buildModule, nextPracticeQuestion } from '../js/adaptive.js';
import { projectSectionScore } from '../js/irt.js';
import { defaultProgress } from '../js/store.js';

test('every test lists its sections, skills and domain shares consistently', () => {
  for (const id of EXAM_IDS) {
    const exam = EXAMS[id];
    for (const section of exam.sections) {
      const domains = exam.domains.filter(d => d.section === section.id).map(d => d.name);
      assert.ok(domains.length, `${id} ${section.id} has domains`);
      assert.deepEqual(Object.keys(exam.domainShare[section.id]).sort(), [...domains].sort(), `${id} ${section.id} shares name its domains`);
      const total = Object.values(exam.domainShare[section.id]).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 0.02, `${id} ${section.id} shares add up to about 1 (${total})`);
      assert.ok(skillsOf(exam, section.id).length, `${id} ${section.id} has skills`);
    }
  }
});

test('section formats match the official test specifications', () => {
  const format = id => EXAMS[id].sections.map(s => [s.id, s.perModule * s.modules, s.minutes * s.modules]);
  for (const id of ['sat', 'psat', 'psat89']) assert.deepEqual(format(id), [['RW', 54, 64], ['MATH', 44, 70]]);
  assert.deepEqual(format('act'), [['ENG', 50, 35], ['MATH', 45, 50], ['READ', 36, 40], ['SCI', 40, 40]]);
  assert.deepEqual(scoredSections(EXAMS.act).map(s => s.id), ['ENG', 'MATH', 'READ'], 'Science is optional');
});

test('exported questions are sorted into the right test', () => {
  assert.equal(examOfQuestion({ assessment: 'SAT' }), 'sat');
  assert.equal(examOfQuestion({ assessment: 'PSAT/NMSQT and PSAT 10' }), 'psat');
  assert.equal(examOfQuestion({ assessment: 'PSAT 8/9' }), 'psat89');
  assert.equal(examOfQuestion({ source: 'demo' }), 'sat');
  assert.equal(examOfQuestion({ source: 'act-export' }), 'act');
});

test('scores land on each test’s own scale, and the ACT Composite is an average', () => {
  for (const id of EXAM_IDS) {
    const { scale } = EXAMS[id];
    assert.equal(projectSectionScore({ theta: 9, se: 1 }, scale).high, scale.max, `${id} tops out at ${scale.max}`);
    assert.equal(projectSectionScore({ theta: -9, se: 1 }, scale).low, scale.min, `${id} bottoms out at ${scale.min}`);
  }
  const sat = totalScore(EXAMS.sat, { RW: { low: 560, mid: 600, high: 640 }, MATH: { low: 580, mid: 620, high: 660 } });
  assert.deepEqual(sat, { low: 1140, mid: 1220, high: 1300 });
  const act = totalScore(EXAMS.act, { ENG: { low: 20, mid: 23, high: 26 }, MATH: { low: 24, mid: 27, high: 30 }, READ: { low: 21, mid: 25, high: 28 } });
  assert.deepEqual(act, { low: 22, mid: 25, high: 28 });
  assert.equal(totalScore(EXAMS.act, { ENG: { low: 20, mid: 23, high: 26 } }), null, 'no Composite until every scored section has an estimate');
});

test('ACT practice and modules draw on ACT skills', () => {
  const pool = ['Algebra', 'Functions', 'Geometry', 'Integrating Essential Skills'].flatMap((skill, k) =>
    Array.from({ length: 6 }, (_, i) => ({
      id: `act-${k}-${i}`, exam: 'act', section: 'MATH', skill, difficulty: 'Medium', choices: [], answer: 'A',
      domain: skill === 'Integrating Essential Skills' ? skill : 'Preparing for Higher Math',
    })));
  const q = nextPracticeQuestion(pool, defaultProgress(), 'MATH', { exam: EXAMS.act });
  assert.ok(q && q.exam === 'act');
  const module = buildModule(pool, 'MATH', null, new Set(), 20, EXAMS.act);
  assert.equal(module.length, 20);
  assert.equal(new Set(module.map(x => x.id)).size, 20);
});
