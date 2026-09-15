// The tests Test Prep covers, and everything that differs between them: sections and timing, skills and how
// much of each section they make up, score scales, and which exported questions belong to each test.

import { DOMAINS as CB_DOMAINS, GRADE_PRIOR } from './taxonomy.js';
import { ACT_DOMAINS } from './taxonomy-act.js';

// College Board's digital SAT Suite: two adaptive modules per section, the same structure for the SAT,
// PSAT/NMSQT and PSAT 10, and PSAT 8/9. Domain shares are approximate, from College Board's test specifications.
const COLLEGE_BOARD = {
  maker: 'College Board',
  source: 'cb',
  adaptive: true,
  domains: CB_DOMAINS,
  sections: [
    { id: 'RW', name: 'Reading and Writing', short: 'R&W', perModule: 27, modules: 2, minutes: 32, tools: ['highlighter'] },
    { id: 'MATH', name: 'Math', short: 'Math', perModule: 22, modules: 2, minutes: 35, tools: ['calculator', 'reference'] },
  ],
  domainShare: {
    RW: { 'Craft and Structure': 0.28, 'Information and Ideas': 0.26, 'Standard English Conventions': 0.26, 'Expression of Ideas': 0.2 },
    MATH: { Algebra: 0.35, 'Advanced Math': 0.35, 'Problem-Solving and Data Analysis': 0.15, 'Geometry and Trigonometry': 0.15 },
  },
};

// Starting ability for a student who picks a grade instead of taking the placement test, relative to each test's
// own difficulty labels. Deliberately modest: responses quickly outweigh it.
const shift = (prior, by) => Object.fromEntries(Object.entries(prior).map(([grade, theta]) => [grade, Math.round((theta + by) * 100) / 100]));

export const EXAMS = {
  sat: {
    ...COLLEGE_BOARD,
    id: 'sat', name: 'SAT', long: 'SAT',
    scale: { min: 200, max: 800, center: 500, spread: 110, step: 10 },
    total: { kind: 'sum', min: 400, max: 1600 },
    grades: [8, 9, 10, 11, 12], gradePrior: GRADE_PRIOR,
  },
  psat: {
    ...COLLEGE_BOARD,
    id: 'psat', name: 'PSAT', long: 'PSAT/NMSQT and PSAT 10',
    scale: { min: 160, max: 760, center: 460, spread: 110, step: 10 },
    total: { kind: 'sum', min: 320, max: 1520 },
    grades: [8, 9, 10, 11], gradePrior: shift(GRADE_PRIOR, 0.25),
  },
  psat89: {
    ...COLLEGE_BOARD,
    id: 'psat89', name: 'PSAT 8/9', long: 'PSAT 8/9',
    scale: { min: 120, max: 720, center: 420, spread: 110, step: 10 },
    total: { kind: 'sum', min: 240, max: 1440 },
    grades: [8, 9], gradePrior: shift(GRADE_PRIOR, 0.6),
  },
  act: {
    id: 'act', name: 'ACT', long: 'ACT', maker: 'ACT', source: 'act',
    // Not adaptive: each section is one timed block. Science is optional and not part of the Composite.
    adaptive: false,
    domains: ACT_DOMAINS,
    sections: [
      { id: 'ENG', name: 'English', short: 'English', perModule: 50, modules: 1, minutes: 35, tools: ['highlighter'] },
      { id: 'MATH', name: 'Math', short: 'Math', perModule: 45, modules: 1, minutes: 50, tools: ['calculator'] },
      { id: 'READ', name: 'Reading', short: 'Reading', perModule: 36, modules: 1, minutes: 40, tools: ['highlighter'] },
      { id: 'SCI', name: 'Science', short: 'Science', perModule: 40, modules: 1, minutes: 40, tools: ['highlighter'], optional: true },
    ],
    // Midpoints of ACT's enhanced reporting-category ranges (R2519, "Operational Item Reporting Category Alignment").
    domainShare: {
      ENG: { 'Production of Writing': 0.4, 'Knowledge of Language': 0.2, 'Conventions of Standard English': 0.4 },
      MATH: { 'Preparing for Higher Math': 0.8, 'Integrating Essential Skills': 0.2 },
      READ: { 'Key Ideas and Details': 0.48, 'Craft and Structure': 0.29, 'Integration of Knowledge and Ideas': 0.23 },
      SCI: { 'Interpretation of Data': 0.44, 'Scientific Investigation': 0.25, 'Evaluating Scientific Arguments and Models with Evidence': 0.31 },
    },
    scale: { min: 1, max: 36, center: 18, spread: 6, step: 1 },
    total: { kind: 'average', sections: ['ENG', 'MATH', 'READ'], min: 1, max: 36, label: 'Composite' },
    grades: [9, 10, 11, 12], gradePrior: { 8: -0.9, 9: -0.6, 10: -0.3, 11: 0, 12: 0.2 },
  },
};

export const EXAM_IDS = Object.keys(EXAMS);

export const sectionOf = (exam, id) => exam.sections.find(s => s.id === id);
export const scoredSections = exam => exam.sections.filter(s => !s.optional);

export function skillsOf(exam, section) {
  return exam.domains.filter(d => d.section === section).flatMap(d => d.skills.map(s => ({ ...s, domain: d.name, section })));
}

export function skillsForGradeOf(exam, section, grade) {
  return skillsOf(exam, section).filter(s => s.minGrade <= grade);
}

// Which test a question belongs to. College Board exports name the assessment on every question; ACT questions
// come from ACT's own practice tests.
export function examOfQuestion(q) {
  if (q.exam && EXAMS[q.exam]) return q.exam;
  if (q.source === 'act-export') return 'act';
  const assessment = String(q.assessment || 'SAT').toUpperCase();
  if (assessment.includes('8/9')) return 'psat89';
  if (assessment.includes('PSAT')) return 'psat';
  return 'sat';
}

// The total or Composite from section estimates ({ low, mid, high } per section id), or null until every
// section that counts has one.
export function totalScore(exam, bySection) {
  const ids = exam.total.sections ?? scoredSections(exam).map(s => s.id);
  const parts = ids.map(id => bySection[id]);
  if (parts.some(p => !p)) return null;
  const combine = key => {
    const sum = parts.reduce((acc, p) => acc + p[key], 0);
    return exam.total.kind === 'average' ? Math.round(sum / parts.length) : sum;
  };
  return { low: combine('low'), mid: combine('mid'), high: combine('high') };
}
