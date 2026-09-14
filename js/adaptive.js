// Question selection: the placement test, targeted practice, and timed practice-test assembly.
//
// Question shape (see scripts/build-questions.js and demo-questions.js):
//   { id, section: 'RW'|'MATH', domain, skill, difficulty: 'Easy'|'Medium'|'Hard', source: 'cb-export' | 'demo',
//     passage?, stem?  or  promptImage?,
//     choices: [{ letter, text } | { letter, image }] | null,
//     answer: 'B' | ['3/4', '.75'] | null (typed-in answer only available as answerImage),
//     rationale? or rationaleImage?, original? }
// Text fields are plain text; the UI escapes them. Images are { src, width, height }.

import { DIFFICULTY_B, estimateAbility, targetDifficulty } from './irt.js';
import { GRADE_PRIOR, skillsForGrade, skillsForSection } from './taxonomy.js';

export const PLACEMENT = { minItems: 12, maxItems: 22, targetSe: 0.45 };

export const TEST_FORMAT = {
  RW: { perModule: 27, minutes: 32 },
  MATH: { perModule: 22, minutes: 35 },
};

// Approximate share of each domain per module, from College Board's test specifications.
const DOMAIN_SHARE = {
  RW: { 'Craft and Structure': 0.28, 'Information and Ideas': 0.26, 'Standard English Conventions': 0.26, 'Expression of Ideas': 0.2 },
  MATH: { Algebra: 0.35, 'Advanced Math': 0.35, 'Problem-Solving and Data Analysis': 0.15, 'Geometry and Trigonometry': 0.15 },
};

const b = q => DIFFICULTY_B[q.difficulty] ?? 0;

export function prior(progress, section) {
  const placed = progress.placement[section];
  if (placed) return { mean: placed.theta, sd: Math.max(placed.se, 0.5) };
  if (progress.profile.grade) return { mean: GRADE_PRIOR[progress.profile.grade], sd: 1 };
  return { mean: 0, sd: 1 };
}

export function sectionAbility(progress, section) {
  // Placement results are already folded into the prior, so only later responses update it.
  const rs = progress.responses.filter(r => r.section === section && r.source !== 'placement');
  return estimateAbility(rs, prior(progress, section));
}

export function skillAbilities(progress, section) {
  const overall = sectionAbility(progress, section);
  return skillsForSection(section).map(skill => {
    const rs = progress.responses.filter(r => r.section === section && r.skill === skill.name);
    const est = estimateAbility(rs, { mean: overall.theta, sd: 0.8 });
    return { ...skill, ...est, answered: rs.length, correct: rs.filter(r => r.correct).length };
  });
}

// ---- Placement ----

export function nextPlacementQuestion(pool, answered, section) {
  const seen = new Set(answered.map(r => r.qid));
  const est = estimateAbility(answered, { mean: 0, sd: 1 });
  if (answered.length >= PLACEMENT.maxItems || (answered.length >= PLACEMENT.minItems && est.se <= PLACEMENT.targetSe)) {
    return { done: true, estimate: est };
  }
  const candidates = pool.filter(q => q.section === section && !seen.has(q.id));
  if (!candidates.length) return { done: true, estimate: est };

  // Cover domains evenly, then pick the item most informative at the current estimate (for a Rasch
  // model, the one whose difficulty is closest to it).
  const domainCounts = {};
  for (const r of answered) domainCounts[r.domain] = (domainCounts[r.domain] || 0) + 1;
  const leastCovered = Math.min(...candidates.map(q => domainCounts[q.domain] || 0));
  const inDomain = candidates.filter(q => (domainCounts[q.domain] || 0) === leastCovered);
  return { done: false, question: closestTo(inDomain, est.theta), estimate: est };
}

// ---- Practice ----

export function nextPracticeQuestion(pool, progress, section, { skill } = {}) {
  const grade = progress.profile.mode === 'grade' && !progress.placement[section] ? progress.profile.grade : null;
  const allowed = new Set((grade ? skillsForGrade(section, grade) : skillsForSection(section)).map(s => s.name));
  if (skill) allowed.add(skill); // a skill the student picks themselves is served regardless of grade
  const abilities = skillAbilities(progress, section).filter(s => allowed.has(s.name));

  const lastSeen = new Map(progress.responses.map(r => [r.qid, r.at]));
  const available = pool.filter(q => q.section === section && allowed.has(q.skill));
  if (!available.length) return null;

  let skillName = skill;
  if (!skillName) {
    // Weight skills toward weakness; untouched skills get a boost so everything gets sampled.
    const withQuestions = abilities.filter(s => available.some(q => q.skill === s.name));
    const weights = withQuestions.map(s => Math.exp(-s.theta) * (s.answered < 3 ? 2 : 1));
    skillName = weightedPick(withQuestions, weights)?.name;
  }
  const est = abilities.find(s => s.name === skillName) || sectionAbility(progress, section);
  const inSkill = available.filter(q => q.skill === skillName);
  const unseen = inSkill.filter(q => !lastSeen.has(q.id));
  const choices = unseen.length ? unseen : [...inSkill].sort((a, c) => lastSeen.get(a.id) - lastSeen.get(c.id)).slice(0, Math.ceil(inSkill.length / 2));
  return closestTo(choices, targetDifficulty(est.theta));
}

// ---- Timed practice tests ----

// Module 1 mixes difficulties; module 2 is harder or easier depending on module 1. College Board does
// not publish its routing rule, so the threshold here is an approximation.
export const ROUTING_THRESHOLD = 0.6;

export function buildModule(pool, section, route, exclude = new Set(), size = TEST_FORMAT[section].perModule) {
  const mix = route === 'hard' ? { Easy: 0.15, Medium: 0.4, Hard: 0.45 }
    : route === 'easy' ? { Easy: 0.45, Medium: 0.4, Hard: 0.15 }
    : { Easy: 0.33, Medium: 0.34, Hard: 0.33 };
  const picked = [];
  for (const [domain, share] of Object.entries(DOMAIN_SHARE[section])) {
    const want = Math.round(share * size);
    const inDomain = shuffle(pool.filter(q => q.section === section && q.domain === domain && !exclude.has(q.id)));
    for (const [difficulty, frac] of Object.entries(mix)) {
      picked.push(...inDomain.filter(q => q.difficulty === difficulty).slice(0, Math.round(want * frac)));
    }
  }
  // Fill any shortfall (small imports, rounding) from whatever remains.
  const used = new Set(picked.map(q => q.id));
  const rest = shuffle(pool.filter(q => q.section === section && !exclude.has(q.id) && !used.has(q.id)));
  const module = [...picked, ...rest].slice(0, size);
  // Order roughly easy to hard within each domain block, like the real test.
  return module.sort((a, c) => domainOrder(section, a) - domainOrder(section, c) || b(a) - b(c));
}

export function routeFor(module1Responses) {
  const correct = module1Responses.filter(r => r.correct).length;
  return correct / Math.max(1, module1Responses.length) >= ROUTING_THRESHOLD ? 'hard' : 'easy';
}

// ---- helpers ----

export function isCorrect(question, response) {
  if (response == null || response === '') return false;
  if (question.choices) return response === question.answer;
  const accepted = Array.isArray(question.answer) ? question.answer : [question.answer];
  const value = toNumber(response);
  return accepted.some(a => a.trim() === String(response).trim() || (value !== null && toNumber(a) !== null && Math.abs(toNumber(a) - value) < 1e-9));
}

function toNumber(text) {
  const s = String(text).trim().replace(/−/g, '-');
  const frac = s.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[2]) === 0 ? null : Number(frac[1]) / Number(frac[2]);
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
}

function domainOrder(section, q) {
  return Object.keys(DOMAIN_SHARE[section]).indexOf(q.domain);
}

function closestTo(list, targetB) {
  const ranked = shuffle(list).sort((x, y) => Math.abs(b(x) - targetB) - Math.abs(b(y) - targetB));
  return ranked[0] || null;
}

function weightedPick(items, weights) {
  const total = weights.reduce((a, w) => a + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) <= 0) return items[i];
  return items[items.length - 1];
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
