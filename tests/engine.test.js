import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY_B, estimateAbility, projectSectionScore, targetDifficulty } from '../js/irt.js';
import { addMistake, dueMistakes, reviewMistake } from '../js/srs.js';
import { buildModule, isCorrect, nextPlacementQuestion, nextPracticeQuestion, PLACEMENT, routeFor, TEST_FORMAT } from '../js/adaptive.js';
import { findSkill, DOMAINS } from '../js/taxonomy.js';
import { DEMO_QUESTIONS } from '../js/demo-questions.js';
import { evaluate } from '../js/calc.js';

const DAY = 24 * 60 * 60 * 1000;
const blankProgress = () => ({ profile: { mode: null, grade: null }, placement: { RW: null, MATH: null }, responses: [], mistakes: {} });

test('ability rises with correct hard answers and falls with wrong easy ones', () => {
  const strong = estimateAbility(Array(8).fill({ b: DIFFICULTY_B.Hard, correct: true }));
  const weak = estimateAbility(Array(8).fill({ b: DIFFICULTY_B.Easy, correct: false }));
  assert.ok(strong.theta > 1, `strong theta ${strong.theta}`);
  assert.ok(weak.theta < -1, `weak theta ${weak.theta}`);
});

test('uncertainty shrinks as responses accumulate', () => {
  const mixed = n => Array.from({ length: n }, (_, i) => ({ b: 0, correct: i % 2 === 0 }));
  assert.ok(estimateAbility(mixed(20)).se < estimateAbility(mixed(4)).se);
});

test('practice targets roughly 70% success', () => {
  const b = targetDifficulty(0.5, 0.7);
  assert.ok(Math.abs(1 / (1 + Math.exp(-(0.5 - b))) - 0.7) < 1e-9);
});

test('score projection stays within 200–800 and is ordered', () => {
  const s = projectSectionScore({ theta: 5, se: 1 });
  assert.equal(s.high, 800);
  assert.ok(s.low <= s.mid && s.mid <= s.high);
  assert.equal(projectSectionScore({ theta: -9, se: 0.1 }).low, 200);
});

test('student-produced responses accept equivalent fractions and decimals', () => {
  const q = { choices: null, answer: ['3/4', '.75'] };
  assert.ok(isCorrect(q, '0.75'));
  assert.ok(isCorrect(q, '6/8'));
  assert.ok(!isCorrect(q, '0.7'));
  assert.ok(!isCorrect(q, ''));
  assert.ok(isCorrect({ choices: [], answer: 'B' }, 'B'));
});

test('missed questions come back on a growing schedule and graduate', () => {
  const now = Date.now();
  const m = addMistake({}, 'q1', 'careless', now);
  assert.deepEqual(dueMistakes(m, now), []);
  assert.deepEqual(dueMistakes(m, now + DAY), ['q1']);
  let t = now;
  for (let k = 0; k < 5; k++) { t += 31 * DAY; reviewMistake(m, 'q1', true, t); }
  assert.equal(m.q1, undefined);
  addMistake(m, 'q2', null, now);
  reviewMistake(m, 'q2', true, now);
  reviewMistake(m, 'q2', false, now);
  assert.equal(m.q2.box, 0);
});

test('placement stops at the item cap and balances domains', () => {
  const pool = DEMO_QUESTIONS;
  const answered = [];
  let step;
  while (!(step = nextPlacementQuestion(pool, answered, 'MATH')).done) {
    answered.push({ qid: step.question.id, domain: step.question.domain, b: DIFFICULTY_B[step.question.difficulty], correct: true });
  }
  assert.ok(answered.length <= PLACEMENT.maxItems);
  assert.equal(new Set(answered.map(a => a.qid)).size, answered.length);
  const firstFour = new Set(answered.slice(0, 4).map(a => a.domain));
  assert.equal(firstFour.size, 4);
});

test('practice respects grade-level skill limits', () => {
  const progress = { ...blankProgress(), profile: { mode: 'grade', grade: 8 } };
  for (let k = 0; k < 30; k++) {
    const q = nextPracticeQuestion(DEMO_QUESTIONS, progress, 'MATH');
    assert.ok(findSkill(q.skill).minGrade <= 8, `${q.skill} served to grade 8`);
  }
});

test('timed modules have no duplicates and route by module 1 performance', () => {
  const module = buildModule(DEMO_QUESTIONS, 'MATH', null);
  assert.ok(module.length <= TEST_FORMAT.MATH.perModule);
  assert.equal(new Set(module.map(q => q.id)).size, module.length);
  assert.equal(routeFor([{ correct: true }, { correct: true }, { correct: false }]), 'hard');
  assert.equal(routeFor([{ correct: false }, { correct: true }, { correct: false }]), 'easy');
});

test('demo questions are well-formed and map onto the taxonomy', () => {
  const domainOf = new Map(DOMAINS.flatMap(d => d.skills.map(s => [s.name, d])));
  for (const q of DEMO_QUESTIONS) {
    const skill = findSkill(q.skill);
    assert.ok(skill, `${q.id}: unknown skill ${q.skill}`);
    assert.equal(domainOf.get(q.skill).name, q.domain, `${q.id}: domain mismatch`);
    assert.equal(skill.section, q.section, `${q.id}: section mismatch`);
    assert.ok(q.difficulty in DIFFICULTY_B, `${q.id}: difficulty`);
    if (q.choices) assert.ok(q.choices.some(c => c.letter === q.answer), `${q.id}: answer not a choice`);
    else assert.ok(Array.isArray(q.answer) && q.answer.length, `${q.id}: missing accepted answers`);
  }
});

test('demo math answer keys match computed values', () => {
  const byId = Object.fromEntries(DEMO_QUESTIONS.map(q => [q.id, q]));
  const choice = id => byId[id].choices.find(c => c.letter === byId[id].answer).text;
  assert.equal(Number(choice('demo-m1')), (21 + 7) / 4);
  assert.equal(Number(choice('demo-m2')), (3 * 5 + 2) - (3 * 1 + 2));
  assert.equal(Number(byId['demo-m3'].answer[0]), ((10 + 4) / 2) * ((10 - 4) / 2));
  assert.equal(Number(choice('demo-m4')), [2, 3, 4, 5].filter(x => 2 * x + 3 > 11)[0]);
  assert.equal(Number(choice('demo-m5')), 2 * 3 + 1);
  assert.equal(Number(byId['demo-m7'].answer[0]), [2, 3].reduce((a, r) => (r * r - 5 * r + 6 === 0 ? a + r : NaN), 0));
  assert.equal(2 ** Number(choice('demo-m8')), 32);
  assert.equal(Number(choice('demo-m9')), 0.15 * 80);
  assert.equal(Number(byId['demo-m10'].answer[0]), (150 / 2.5) * 4);
  assert.equal(Number(choice('demo-m11')), (2 + 4 + 4 + 5 + 10) / 5);
  assert.equal(Number(choice('demo-m12')), 9 * 4);
  assert.equal(choice('demo-m13'), '4/5');
  assert.equal(Number(byId['demo-m14'].answer[0]), Math.sqrt(49));
});

test('calculator evaluates expressions safely', () => {
  assert.equal(evaluate('sqrt(3^2+4^2)'), 5);
  assert.equal(evaluate('2(3+4)'), 14);
  assert.equal(evaluate('-2^2'), -4);
  assert.ok(Math.abs(evaluate('sin(30)') - 0.5) < 1e-12);
  assert.ok(Math.abs(evaluate('sin(pi/6)', { degrees: false }) - 0.5) < 1e-12);
  assert.throws(() => evaluate('alert(1)'));
});
