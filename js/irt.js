// Ability estimation with a one-parameter (Rasch) item response model.
//
// College Board labels each question Easy, Medium or Hard. We place those on a logit scale and
// estimate ability as the expected a posteriori (EAP) value over a fixed grid, which stays stable
// with only a handful of responses and lets a grade-level choice act as the prior.

export const DIFFICULTY_B = { Easy: -1.1, Medium: 0, Hard: 1.1 };

const GRID = Array.from({ length: 81 }, (_, i) => -4 + i * 0.1);

export function pCorrect(theta, b) {
  return 1 / (1 + Math.exp(-(theta - b)));
}

// responses: [{ b, correct }]; prior: normal distribution on ability.
export function estimateAbility(responses, prior = { mean: 0, sd: 1 }) {
  const logPost = GRID.map(t => -((t - prior.mean) ** 2) / (2 * prior.sd ** 2));
  for (const r of responses) {
    for (let i = 0; i < GRID.length; i++) {
      const p = pCorrect(GRID[i], r.b);
      logPost[i] += Math.log(r.correct ? p : 1 - p);
    }
  }
  const peak = Math.max(...logPost);
  const weights = logPost.map(l => Math.exp(l - peak));
  const total = weights.reduce((a, w) => a + w, 0);
  const theta = GRID.reduce((a, t, i) => a + t * weights[i], 0) / total;
  const variance = GRID.reduce((a, t, i) => a + (t - theta) ** 2 * weights[i], 0) / total;
  return { theta, se: Math.sqrt(variance) };
}

// The question difficulty at which a student of ability theta succeeds with probability `rate`.
// Practice aims near 70%: hard enough to learn from, easy enough not to discourage.
export function targetDifficulty(theta, rate = 0.7) {
  return theta - Math.log(rate / (1 - rate));
}

// Nearest College Board difficulty label to a logit difficulty.
export function nearestLabel(b) {
  return Object.entries(DIFFICULTY_B).reduce((best, [label, value]) =>
    Math.abs(value - b) < Math.abs(DIFFICULTY_B[best] - b) ? label : best, 'Medium');
}

// Rough section-score projection (200–800). This is a heuristic mapping, not College Board's scoring:
// real scores depend on item parameters College Board does not publish. Always show it as a range.
export function projectSectionScore({ theta, se }) {
  const toScore = t => Math.min(800, Math.max(200, Math.round((500 + 110 * t) / 10) * 10));
  return { low: toScore(theta - se), mid: toScore(theta), high: toScore(theta + se) };
}
