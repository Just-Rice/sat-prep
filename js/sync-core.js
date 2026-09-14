// Cloud sync logic that doesn't depend on Firebase or the browser, so Node tests cover it (see sync.js
// for the Firebase side).
//
// Every device keeps a full copy of progress in localStorage, and merging is built so devices converge
// whatever order they sync in: answers and tests are append-only and combine by identity; each mistake-log
// entry and the profile, placement and plan settings keep whichever copy changed last; and "Reset all
// progress" records a time, after which anything older is dropped on every device.
//
// Cloud layout, one Firestore document per path:
//   main       everything except answers, as JSON
//   YYYY-MM-1  answers from the 1st–15th of a month (UTC), as JSON; YYYY-MM-2 for the rest of the month.
//              Half-month chunks keep documents far below Firestore's 1 MiB limit, and a new answer only
//              rewrites the current chunk.

import { defaultProgress } from './store.js';

const SETTINGS = ['profile', 'placement', 'plan'];

const responseKey = r => `${r.qid}|${r.at}|${r.source}`;
const entryTime = m => m.updatedAt ?? m.missedAt ?? 0;
const byTimeThenKey = (x, y) => x.at - y.at || (responseKey(x) < responseKey(y) ? -1 : 1);

export function mergeProgress(a, b) {
  const resetAt = Math.max(a.resetAt || 0, b.resetAt || 0);
  const merged = { ...defaultProgress(), resetAt };

  for (const key of SETTINGS) {
    const timeA = a.stamps?.[key] || 0;
    const timeB = b.stamps?.[key] || 0;
    merged[key] = structuredClone((timeB > timeA ? b : a)[key] ?? merged[key]);
    merged.stamps[key] = Math.max(timeA, timeB);
  }

  const responses = new Map();
  for (const r of [...(a.responses || []), ...(b.responses || [])]) {
    if (r.at > resetAt) responses.set(responseKey(r), r);
  }
  merged.responses = [...responses.values()].sort(byTimeThenKey);

  const tests = new Map();
  for (const t of [...(a.tests || []), ...(b.tests || [])]) {
    if (t.at > resetAt) tests.set(t.id, t);
  }
  merged.tests = [...tests.values()].sort((x, y) => x.at - y.at);

  for (const [qid, entry] of [...Object.entries(a.mistakes || {}), ...Object.entries(b.mistakes || {})]) {
    if (entryTime(entry) <= resetAt) continue;
    const current = merged.mistakes[qid];
    if (!current || entryTime(entry) > entryTime(current)) merged.mistakes[qid] = entry;
  }
  return merged;
}

export function periodOf(at) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCDate() <= 15 ? 1 : 2}`;
}

export function toCloud(progress) {
  const mistakes = Object.fromEntries(Object.entries(progress.mistakes || {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  const main = JSON.stringify({
    profile: progress.profile, placement: progress.placement, plan: progress.plan,
    stamps: progress.stamps, resetAt: progress.resetAt || 0, mistakes, tests: progress.tests,
  });
  const groups = {};
  for (const r of [...progress.responses].sort(byTimeThenKey)) (groups[periodOf(r.at)] ||= []).push(r);
  const chunks = Object.fromEntries(Object.entries(groups).map(([period, rs]) => [period, JSON.stringify(rs)]));
  return { main, chunks };
}

export function fromCloud(main, chunks) {
  return {
    ...defaultProgress(),
    ...(main ? JSON.parse(main) : {}),
    responses: Object.values(chunks).flatMap(json => JSON.parse(json)),
  };
}

// Syncs local progress with the cloud and returns the merged result, which the caller saves locally.
//
// backend: { readAll() -> { main, chunks }, transact(fn) } where fn receives { get(path), set(path, json),
// del(path) } and every get happens before any set or del (a Firestore transaction rule).
// known: an object this function keeps between calls, remembering the JSON last seen for each cloud
// document. A full sync reads everything; a routine push re-reads only the documents it is about to
// change, inside the transaction, so a write from another device in the meantime is merged, not lost.
export async function syncProgress(backend, local, known, { full = false } = {}) {
  if (full || !known.docs) {
    const all = await backend.readAll();
    known.docs = new Map(Object.entries(all.chunks));
    known.docs.set('main', all.main);
  }
  const snapshot = known.docs;

  const result = await backend.transact(async tx => {
    const draft = toCloud(local);
    const remote = new Map(snapshot);
    for (const [path, json] of [['main', draft.main], ...Object.entries(draft.chunks)]) {
      if (json !== snapshot.get(path)) remote.set(path, await tx.get(path));
    }
    const remoteChunks = Object.fromEntries([...remote].filter(([path, json]) => path !== 'main' && json != null));
    const merged = mergeProgress(local, fromCloud(remote.get('main'), remoteChunks));

    const next = toCloud(merged);
    const written = new Map();
    for (const path of new Set([...remote.keys(), 'main', ...Object.keys(next.chunks)])) {
      const json = path === 'main' ? next.main : next.chunks[path] ?? null;
      if (json === (remote.get(path) ?? null)) continue;
      if (json === null) tx.del(path);
      else tx.set(path, json);
      written.set(path, json);
    }
    return { merged, remote, written };
  });

  known.docs = new Map(result.remote);
  for (const [path, json] of result.written) {
    if (json === null) known.docs.delete(path);
    else known.docs.set(path, json);
  }
  return result.merged;
}
