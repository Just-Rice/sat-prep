// ACT reporting categories, from ACT's "Design Framework for the ACT Enhancements" (R2519, February 2026). The
// reporting categories are the domains; Preparing for Higher Math is split into its five subcategories, which is
// how ACT's score reports and answer keys break it down. ACT doesn't publish a skill list below that level.
//
// minGrade is our approximation of when a typical course sequence covers the material, used only in grade mode.

export const ACT_DOMAINS = [
  {
    section: 'ENG', code: 'POW', name: 'Production of Writing',
    skills: [{ code: 'POW', name: 'Production of Writing', minGrade: 9 }],
  },
  {
    section: 'ENG', code: 'KLA', name: 'Knowledge of Language',
    skills: [{ code: 'KLA', name: 'Knowledge of Language', minGrade: 9 }],
  },
  {
    section: 'ENG', code: 'CSE', name: 'Conventions of Standard English',
    skills: [{ code: 'CSE', name: 'Conventions of Standard English', minGrade: 9 }],
  },
  {
    section: 'MATH', code: 'PHM', name: 'Preparing for Higher Math',
    skills: [
      { code: 'N', name: 'Number and Quantity', minGrade: 10 },
      { code: 'A', name: 'Algebra', minGrade: 9 },
      { code: 'F', name: 'Functions', minGrade: 10 },
      { code: 'G', name: 'Geometry', minGrade: 9 },
      { code: 'S', name: 'Statistics and Probability', minGrade: 9 },
    ],
  },
  {
    section: 'MATH', code: 'IES', name: 'Integrating Essential Skills',
    skills: [{ code: 'IES', name: 'Integrating Essential Skills', minGrade: 9 }],
  },
  {
    section: 'READ', code: 'KID', name: 'Key Ideas and Details',
    skills: [{ code: 'KID', name: 'Key Ideas and Details', minGrade: 9 }],
  },
  {
    section: 'READ', code: 'CS', name: 'Craft and Structure',
    skills: [{ code: 'CS', name: 'Craft and Structure', minGrade: 9 }],
  },
  {
    section: 'READ', code: 'IKI', name: 'Integration of Knowledge and Ideas',
    skills: [{ code: 'IKI', name: 'Integration of Knowledge and Ideas', minGrade: 9 }],
  },
  {
    section: 'SCI', code: 'IOD', name: 'Interpretation of Data',
    skills: [{ code: 'IOD', name: 'Interpretation of Data', minGrade: 9 }],
  },
  {
    section: 'SCI', code: 'SIN', name: 'Scientific Investigation',
    skills: [{ code: 'SIN', name: 'Scientific Investigation', minGrade: 9 }],
  },
  {
    section: 'SCI', code: 'EMI', name: 'Evaluating Scientific Arguments and Models with Evidence',
    skills: [{ code: 'EMI', name: 'Evaluating Scientific Arguments and Models with Evidence', minGrade: 10 }],
  },
];
