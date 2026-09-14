// Spaced review for missed questions, Leitner-style: each correct review moves a question to a longer
// interval, and a miss sends it back to the start. A question graduates after the last box.

const INTERVAL_DAYS = [1, 3, 7, 14, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

export function addMistake(mistakes, qid, reason, now = Date.now()) {
  mistakes[qid] = { box: 0, due: now + INTERVAL_DAYS[0] * DAY_MS, reason, missedAt: now, lapses: (mistakes[qid]?.lapses || 0) + 1 };
  return mistakes;
}

export function reviewMistake(mistakes, qid, correct, now = Date.now()) {
  const entry = mistakes[qid];
  if (!entry) return mistakes;
  if (!correct) return addMistake(mistakes, qid, entry.reason, now);
  const box = entry.box + 1;
  if (box >= INTERVAL_DAYS.length) delete mistakes[qid];
  else mistakes[qid] = { ...entry, box, due: now + INTERVAL_DAYS[box] * DAY_MS };
  return mistakes;
}

export function dueMistakes(mistakes, now = Date.now()) {
  return Object.entries(mistakes)
    .filter(([, m]) => m.due <= now)
    .sort((a, b) => a[1].due - b[1].due)
    .map(([qid]) => qid);
}
