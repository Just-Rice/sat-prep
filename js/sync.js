// Cloud sync: sign in with Google, or with a username and passcode, and progress for every test (SAT, PSAT/NMSQT,
// PSAT 8/9, ACT) follows the student across devices automatically. Uses Firebase Authentication and Cloud Firestore
// on Firebase's free Spark plan. Nothing loads until js/firebase-config.js is filled in.
//
// While signed in: local changes upload shortly after they're saved (and right away when the tab is hidden or
// closed), live Firestore listeners bring in changes from other devices as they happen, and a failed sync retries
// on its own.
//
// Cloud layout per user: the SAT stays where it was before other tests existed (users/{uid} and
// users/{uid}/responses); every other test lives under users/{uid}/exams/{exam}.

import { FIREBASE_CONFIG } from './firebase-config.js';
import { mergeProgress, progressFromDocs, syncProgress } from './sync-core.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
// Username accounts are Firebase email/password accounts at a reserved domain that can never receive mail,
// so they have no passcode reset.
const USERNAME_DOMAIN = 'users.sat-prep.invalid';
const PUSH_DELAY_MS = 1500;
const RETRY_MS = 30 * 1000;
const STALE_MS = 5 * 60 * 1000;

export const syncConfigured = Boolean(FIREBASE_CONFIG);

let fb = null;
let hooks = null;   // { exams, getProgress(exam), setProgress(exam, progress), onChange }
let user = null;
let known = {};     // exam → what syncProgress remembers about that test's cloud documents
let pushTimer = null;
let pendingExams = new Set();
let retryTimer = null;
let running = null;
let rerun = null;
let stopListening = null;
const state = { phase: syncConfigured ? 'loading' : 'off', message: null, lastSynced: null };

// phase: 'off' (not configured) | 'loading' | 'signed-out' | 'syncing' | 'synced' | 'error'
export const syncState = () => ({ ...state, account: accountName() });

function update(patch) {
  Object.assign(state, patch);
  hooks?.onChange(syncState());
}

const loadFromCdn = async () => {
  const [app, auth, firestore] = await Promise.all(['app', 'auth', 'firestore'].map(m => import(`${SDK}/firebase-${m}.js`)));
  return { app, auth, firestore };
};

// loadSdk lets tests supply the Firebase modules from npm instead of the CDN.
export async function initSync(appHooks, { loadSdk = loadFromCdn } = {}) {
  hooks = appHooks;
  if (!syncConfigured) return;
  try {
    const { app, auth, firestore } = await loadSdk();
    const firebaseApp = app.initializeApp(FIREBASE_CONFIG);
    fb = { auth, firestore, authInstance: auth.getAuth(firebaseApp), db: firestore.getFirestore(firebaseApp) };
  } catch {
    update({ phase: 'error', message: 'Cloud sync could not load. Check your connection and reload the page.' });
    return;
  }
  fb.auth.onAuthStateChanged(fb.authInstance, signedIn => {
    stopListening?.();
    clearTimeout(pushTimer);
    clearTimeout(retryTimer);
    pushTimer = null;
    pendingExams = new Set();
    user = signedIn;
    known = {};
    update({ phase: signedIn ? 'syncing' : 'signed-out', message: null, lastSynced: null });
    if (signedIn) syncNow({ full: true });
  });
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Upload pending changes before the tab is put away or closed.
      if (pushTimer) flushPush();
    } else if (state.phase === 'error' || Date.now() - (state.lastSynced || 0) > STALE_MS) {
      syncNow({ full: true });
    }
  });
  globalThis.window?.addEventListener('online', () => syncNow({ full: true }));
}

// Called after every local save of a test's progress; changes upload shortly afterwards, batched.
export function schedulePush(exam) {
  if (!user) return;
  pendingExams.add(exam);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flushPush, PUSH_DELAY_MS);
}

function flushPush() {
  clearTimeout(pushTimer);
  pushTimer = null;
  const exams = [...pendingExams];
  pendingExams = new Set();
  if (exams.length) syncNow({ exams });
}

// One sync runs at a time; requests made while one is running are combined and run once it finishes.
export function syncNow({ full = false, exams = hooks?.exams ?? [] } = {}) {
  if (!user || !fb) return Promise.resolve();
  if (running) {
    rerun = { full: full || Boolean(rerun?.full), exams: [...new Set([...(rerun?.exams ?? []), ...exams])] };
    return running;
  }
  running = runSync(full, exams).finally(() => {
    running = null;
    if (rerun) {
      const next = rerun;
      rerun = null;
      syncNow(next);
    }
  });
  return running;
}

async function runSync(full, exams) {
  const uid = user.uid;
  clearTimeout(retryTimer);
  update({ phase: 'syncing', message: null });
  try {
    for (const exam of exams) {
      known[exam] ||= {};
      const merged = await syncProgress(cloudFor(uid, exam), hooks.getProgress(exam), known[exam], { full });
      if (user?.uid !== uid) return;
      // Merge with the local copy once more: the student may have answered something while this ran.
      hooks.setProgress(exam, mergeProgress(hooks.getProgress(exam), merged));
    }
    update({ phase: 'synced', lastSynced: Date.now() });
    if (!stopListening) listen(uid);
  } catch (err) {
    if (user?.uid !== uid) return;
    known = {};
    update({ phase: 'error', message: describeError(err) });
    retryTimer = setTimeout(() => syncNow({ full: true }), RETRY_MS);
  }
}

// Live updates from other devices. Writes this device makes come back through here too; merging them changes
// nothing, so they're ignored.
function listen(uid) {
  const { onSnapshot } = fb.firestore;
  const unsubscribers = [];
  const failed = err => {
    stopListening?.();
    if (user?.uid !== uid) return;
    update({ phase: 'error', message: describeError(err) });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => syncNow({ full: true }), RETRY_MS);
  };
  for (const exam of hooks.exams) {
    const { mainRef, chunksRef } = refsFor(uid, exam);
    const apply = changes => {
      if (user?.uid !== uid) return;
      known[exam] ||= {};
      known[exam].docs ||= new Map();
      for (const [path, json] of changes) known[exam].docs.set(path, json);
      const before = JSON.stringify(hooks.getProgress(exam));
      hooks.setProgress(exam, mergeProgress(hooks.getProgress(exam), progressFromDocs(known[exam].docs)));
      if (JSON.stringify(hooks.getProgress(exam)) !== before || state.phase !== 'synced') {
        update({ phase: 'synced', lastSynced: Date.now(), message: null });
      } else {
        state.lastSynced = Date.now();
      }
    };
    unsubscribers.push(onSnapshot(mainRef, snap => apply([['main', snap.data()?.json ?? null]]), failed));
    unsubscribers.push(onSnapshot(chunksRef,
      snap => apply(snap.docChanges().map(c => [c.doc.id, c.type === 'removed' ? null : c.doc.data().json])), failed));
  }
  stopListening = () => {
    unsubscribers.forEach(stop => stop());
    stopListening = null;
  };
}

function refsFor(uid, exam) {
  const { collection, doc } = fb.firestore;
  const base = exam === 'sat' ? ['users', uid] : ['users', uid, 'exams', exam];
  return {
    mainRef: doc(fb.db, ...base),
    chunksRef: collection(fb.db, ...base, 'responses'),
    chunkRef: period => doc(fb.db, ...base, 'responses', period),
  };
}

function cloudFor(uid, exam) {
  const { getDoc, getDocs, runTransaction } = fb.firestore;
  const { mainRef, chunksRef, chunkRef } = refsFor(uid, exam);
  const ref = path => (path === 'main' ? mainRef : chunkRef(path));
  return {
    async readAll() {
      const [main, chunks] = await Promise.all([getDoc(mainRef), getDocs(chunksRef)]);
      return { main: main.data()?.json ?? null, chunks: Object.fromEntries(chunks.docs.map(d => [d.id, d.data().json])) };
    },
    transact: fn => runTransaction(fb.db, tx => fn({
      get: async path => (await tx.get(ref(path))).data()?.json ?? null,
      set: (path, json) => tx.set(ref(path), { json }),
      del: path => tx.delete(ref(path)),
    })),
  };
}

// ---------- accounts ----------

export async function signInWithGoogle() {
  await authAction(() => fb.auth.signInWithPopup(fb.authInstance, new fb.auth.GoogleAuthProvider()));
}

export async function signInWithUsername(username, passcode, { create = false } = {}) {
  const name = String(username).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(name)) {
    throw new Error('Usernames are 3–30 characters: letters, numbers, dots, dashes or underscores.');
  }
  if (create && passcode.length < 6) throw new Error('Choose a passcode of at least 6 characters.');
  const email = `${name}@${USERNAME_DOMAIN}`;
  const action = create ? fb.auth.createUserWithEmailAndPassword : fb.auth.signInWithEmailAndPassword;
  await authAction(() => action(fb.authInstance, email, passcode));
}

export async function signOutOfSync() {
  // Upload anything still waiting before the account is disconnected.
  if (pushTimer) flushPush();
  await running;
  await fb.auth.signOut(fb.authInstance);
}

function accountName() {
  if (!user) return null;
  const email = user.email || '';
  if (email.endsWith(`@${USERNAME_DOMAIN}`)) return email.slice(0, -(USERNAME_DOMAIN.length + 1));
  return user.displayName || email || 'your account';
}

async function authAction(action) {
  try {
    await action();
  } catch (err) {
    throw new Error(describeError(err));
  }
}

const NO_MATCH = "That username and passcode don't match an account.";
const MESSAGES = {
  'auth/invalid-credential': NO_MATCH,
  'auth/wrong-password': NO_MATCH,
  'auth/user-not-found': NO_MATCH,
  'auth/invalid-email': "That username can't be used.",
  'auth/email-already-in-use': 'That username is taken. Pick another, or sign in if it is yours.',
  'auth/weak-password': 'Choose a passcode of at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/popup-blocked': 'The sign-in window was blocked. Allow pop-ups for this site and try again.',
  'auth/popup-closed-by-user': '',
  'auth/cancelled-popup-request': '',
  'auth/network-request-failed': 'Could not reach the sign-in service. Check your internet connection.',
  'auth/unauthorized-domain': "This site's address isn't on the Firebase project's list of authorized domains.",
  'auth/operation-not-allowed': "That sign-in method isn't turned on in the Firebase project.",
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': "The Firebase settings in js/firebase-config.js aren't valid.",
  'auth/invalid-api-key': "The Firebase settings in js/firebase-config.js aren't valid.",
  'permission-denied': 'The cloud database refused access. Check the Firestore security rules.',
  unavailable: "Offline. Progress is saved on this device and will sync when you're back online.",
};

// An empty string means the student cancelled, so there is nothing to show.
function describeError(err) {
  return MESSAGES[err?.code] ?? `Sync problem: ${err?.message || err}`;
}
