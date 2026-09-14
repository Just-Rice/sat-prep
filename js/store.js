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
    stamps: { profile: 0, placement: 0, plan: 0 },   // when each setting last changed, for cloud sync
    resetAt: 0,                                       // when progress was last reset (see sync-core.js)
  };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
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
  return progress;
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch (err) {
    console.warn('Could not save progress', err);
  }
}
