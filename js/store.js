// The student's progress, kept in localStorage. Nothing leaves the device.

const PROGRESS_KEY = 'satprep.progress.v1';

export function defaultProgress() {
  return {
    profile: { mode: null, grade: null },   // mode: 'placement' | 'grade'
    placement: { RW: null, MATH: null },      // { theta, se, finishedAt }
    responses: [],                            // { qid, section, skill, b, correct, choice, ms, at, source }
    mistakes: {},                             // see srs.js
    tests: [],                                // completed timed practice tests
    plan: { testDate: null, target: null, dailyGoal: 20 },
  };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? { ...defaultProgress(), ...JSON.parse(raw) } : defaultProgress();
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch (err) {
    console.warn('Could not save progress', err);
  }
}
