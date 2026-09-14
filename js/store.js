// Local persistence. Imported questions can run to thousands of entries with images, so they live in
// IndexedDB; the student's progress is small and lives in localStorage. Nothing leaves the device.

const DB_NAME = 'sat-prep';
const PROGRESS_KEY = 'satprep.progress.v1';

let dbPromise;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('questions', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const t = database.transaction('questions', mode);
    const result = fn(t.objectStore('questions'));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const questions = {
  all: () => tx('readonly', s => s.getAll()),
  putMany: list => tx('readwrite', s => { for (const q of list) s.put(q); return { result: list.length }; }),
  clear: () => tx('readwrite', s => s.clear()),
};

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
