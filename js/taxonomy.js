// Digital SAT content taxonomy, using College Board's own domain and skill names so imported
// questions map onto it directly.
//
// minGrade is our approximation of when a typical U.S. course sequence (Algebra 1 → Geometry →
// Algebra 2 → Precalculus) covers a skill. The SAT itself is not graded by grade level; this only
// drives which skills grade-level mode serves before the student's own results take over.

export const SECTIONS = {
  RW: { name: 'Reading and Writing', short: 'R&W' },
  MATH: { name: 'Math', short: 'Math' },
};

export const DOMAINS = [
  {
    section: 'RW', code: 'INI', name: 'Information and Ideas',
    skills: [
      { code: 'CID', name: 'Central Ideas and Details', minGrade: 8 },
      { code: 'INF', name: 'Inferences', minGrade: 8 },
      { code: 'COE', name: 'Command of Evidence', minGrade: 8 },
    ],
  },
  {
    section: 'RW', code: 'CAS', name: 'Craft and Structure',
    skills: [
      { code: 'WIC', name: 'Words in Context', minGrade: 8 },
      { code: 'TSP', name: 'Text Structure and Purpose', minGrade: 8 },
      { code: 'CTC', name: 'Cross-Text Connections', minGrade: 9 },
    ],
  },
  {
    section: 'RW', code: 'EOI', name: 'Expression of Ideas',
    skills: [
      { code: 'SYN', name: 'Rhetorical Synthesis', minGrade: 8 },
      { code: 'TRA', name: 'Transitions', minGrade: 8 },
    ],
  },
  {
    section: 'RW', code: 'SEC', name: 'Standard English Conventions',
    skills: [
      { code: 'BOU', name: 'Boundaries', minGrade: 8 },
      { code: 'FSS', name: 'Form, Structure, and Sense', minGrade: 8 },
    ],
  },
  {
    section: 'MATH', code: 'H', name: 'Algebra',
    skills: [
      { code: 'H.A', name: 'Linear equations in one variable', minGrade: 8 },
      { code: 'H.B', name: 'Linear functions', minGrade: 8 },
      { code: 'H.C', name: 'Linear equations in two variables', minGrade: 8 },
      { code: 'H.D', name: 'Systems of two linear equations in two variables', minGrade: 9 },
      { code: 'H.E', name: 'Linear inequalities in one or two variables', minGrade: 9 },
    ],
  },
  {
    section: 'MATH', code: 'P', name: 'Advanced Math',
    skills: [
      { code: 'P.A', name: 'Equivalent expressions', minGrade: 9 },
      { code: 'P.B', name: 'Nonlinear equations in one variable and systems of equations in two variables', minGrade: 10 },
      { code: 'P.C', name: 'Nonlinear functions', minGrade: 10 },
    ],
  },
  {
    section: 'MATH', code: 'Q', name: 'Problem-Solving and Data Analysis',
    skills: [
      { code: 'Q.A', name: 'Ratios, rates, proportional relationships, and units', minGrade: 8 },
      { code: 'Q.B', name: 'Percentages', minGrade: 8 },
      { code: 'Q.C', name: 'One-variable data: Distributions and measures of center and spread', minGrade: 8 },
      { code: 'Q.D', name: 'Two-variable data: Models and scatterplots', minGrade: 9 },
      { code: 'Q.E', name: 'Probability and conditional probability', minGrade: 9 },
      { code: 'Q.F', name: 'Inference from sample statistics and margin of error', minGrade: 11 },
      { code: 'Q.G', name: 'Evaluating statistical claims: Observational studies and experiments', minGrade: 10 },
    ],
  },
  {
    section: 'MATH', code: 'S', name: 'Geometry and Trigonometry',
    skills: [
      { code: 'S.A', name: 'Area and volume', minGrade: 8 },
      { code: 'S.B', name: 'Lines, angles, and triangles', minGrade: 9 },
      { code: 'S.C', name: 'Right triangles and trigonometry', minGrade: 10 },
      { code: 'S.D', name: 'Circles', minGrade: 10 },
    ],
  },
];

export const GRADES = [8, 9, 10, 11, 12];

// Starting ability (logit scale, see irt.js) assumed for a student who picks a grade instead of
// taking the placement test. Deliberately modest: responses quickly outweigh this prior.
export const GRADE_PRIOR = { 8: -1.0, 9: -0.6, 10: -0.25, 11: 0.1, 12: 0.35 };

const skillIndex = new Map();
for (const d of DOMAINS) {
  for (const s of d.skills) skillIndex.set(normalize(s.name), { ...s, domain: d.name, domainCode: d.code, section: d.section });
}

function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Resolves a skill name as printed in a College Board export to its taxonomy entry.
export function findSkill(name) {
  return skillIndex.get(normalize(name)) || null;
}

export function skillsForSection(section) {
  return DOMAINS.filter(d => d.section === section).flatMap(d => d.skills.map(s => ({ ...s, domain: d.name, section })));
}

export function skillsForGrade(section, grade) {
  return skillsForSection(section).filter(s => s.minGrade <= grade);
}
