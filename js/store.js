// The student's progress, kept in localStorage with one copy per test (SAT, PSAT/NMSQT, PSAT 8/9, ACT). Nothing
// leaves the device unless cloud sync is on.

// The SAT keeps the key it had before other tests existed, so earlier progress carries over.
const keyFor = exam => (exam === 'sat' ? 'satprep.progress.v1' : `satprep.progress.${exam}.v1`);
const EXAM_KEY = 'satprep.exam';

export function defaultProgress() {
  return {
    profile: { mode: null, grade: null },   // mode: 'placement' | 'grade'
    placement: {},                            // section id → { theta, se, items, finishedAt }
    responses: [],                            // { qid, section, skill, b, correct, choice, ms, at, source }
    mistakes: {},                             // see srs.js
    tests: [],                                // completed timed practice tests
    plan: { testDate: null, target: null, dailyGoal: 20 },
    stamps: { profile: 0, placement: 0, plan: 0 },   // when each setting last changed, for cloud sync
    resetAt: 0,                                       // when progress was last reset (see sync-core.js)
  };
}

// True for progress nobody has touched yet, which cloud sync doesn't need to store.
export function isPristine(progress) {
  return !progress.responses?.length && !Object.keys(progress.mistakes || {}).length && !progress.tests?.length
    && !progress.resetAt && Object.values(progress.stamps || {}).every(time => !time);
}

export function loadProgress(exam = 'sat') {
  try {
    const raw = localStorage.getItem(keyFor(exam));
    return raw ? withSyncFields(JSON.parse(raw)) : defaultProgress();
  } catch {
    return defaultProgress();
  }
}

// Progress saved before cloud sync existed has no change times. Settings changed from their defaults get
// the earliest possible time, so they win over a brand-new device but lose to any later edit.
function withSyncFields(saved) {
  const base = defaultProgress();
  const progress = { ...base, ...saved };
  if (!saved.stamps) {
    progress.stamps = Object.fromEntries(Object.keys(base.stamps)
      .map(key => [key, JSON.stringify(saved[key] ?? base[key]) === JSON.stringify(base[key]) ? 0 : 1]));
  }
  // Older SAT progress stored placement as { RW: null, MATH: null }; empty sections are simply absent now.
  progress.placement = Object.fromEntries(Object.entries(progress.placement || {}).filter(([, result]) => result));
  return progress;
}

export function saveProgress(progress, exam = 'sat') {
  try {
    localStorage.setItem(keyFor(exam), JSON.stringify(progress));
  } catch (err) {
    console.warn('Could not save progress', err);
  }
}

export function loadExam(ids) {
  try {
    const saved = localStorage.getItem(EXAM_KEY);
    return ids.includes(saved) ? saved : ids[0];
  } catch {
    return ids[0];
  }
}

export function saveExam(id) {
  try { localStorage.setItem(EXAM_KEY, id); } catch { /* storage unavailable */ }
}
