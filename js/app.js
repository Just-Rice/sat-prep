import * as store from './store.js';
import { DIFFICULTY_B, estimateAbility, pCorrect, projectSectionScore } from './irt.js';
import {
  buildModule, isCorrect, nextPlacementQuestion, nextPracticeQuestion, PLACEMENT, routeFor, sectionAbility, skillAbilities,
} from './adaptive.js';
import { EXAMS, EXAM_IDS, examOfQuestion, scoredSections, sectionOf, skillsOf, totalScore } from './exams.js';
import { addMistake, dueMistakes, reviewMistake } from './srs.js';
import { DEMO_QUESTIONS } from './demo-questions.js';
import { mountCalculator } from './calc.js';
import {
  initSync, schedulePush, signInWithGoogle, signInWithUsername, signOutOfSync, syncConfigured, syncState,
} from './sync.js';

const APP_NAME = 'Test Prep';
const view = document.getElementById('view');
const side = document.getElementById('side');
const topbar = document.getElementById('topbar');
const tabs = document.getElementById('tabs');
const more = document.getElementById('more');
const shell = document.querySelector('.shell');
const SIDEBAR_KEY = 'satprep.sidebarCollapsed';
try { shell.classList.toggle('collapsed', localStorage.getItem(SIDEBAR_KEY) === '1'); } catch { /* storage unavailable */ }
const DAY_MS = 24 * 60 * 60 * 1000;
const MISTAKE_REASONS = ['Careless slip', "Didn't know the concept", 'Misread the question', 'Ran out of time', 'Guessed'];

// Each test (SAT, PSAT/NMSQT, PSAT 8/9, ACT) keeps its own progress; `progress` is the current test's.
let examId = store.loadExam(EXAM_IDS);
let exam = EXAMS[examId];
const progressByExam = Object.fromEntries(EXAM_IDS.map(id => [id, store.loadProgress(id)]));
let progress = progressByExam[examId];
let allQuestions = [];
let pool = [];          // the questions the current test practices with
let byId = new Map();
let library = { source: 'demo', files: 0, warnings: [], own: 0, borrowed: false };
let session = null;     // the active placement, practice or review session
let test = null;        // the timed practice test, kept separately so browsing other pages doesn't end it
let currentRoute = null;
let ticker = null;

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const para = t => esc(t).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const inline = t => esc(t).replace(/\n/g, '<br>');
const $ = sel => view.querySelector(sel);
const on = (sel, event, fn) => view.querySelectorAll(sel).forEach(el => el.addEventListener(event, fn));
const dayKey = t => new Date(t).toLocaleDateString('en-CA');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sectionName = id => sectionOf(exam, id)?.name ?? id;
const sectionShort = id => sectionOf(exam, id)?.short ?? id;
const range = s => `${s.low}–${s.high}`;

const save = () => {
  progressByExam[examId] = progress;
  store.saveProgress(progress, examId);
  schedulePush(examId);
};

// Replaces a test's progress wholesale (a reset, signing out, or a merge from another device).
function replaceProgress(id, next, { push = false } = {}) {
  progressByExam[id] = next;
  if (id === examId) progress = next;
  store.saveProgress(next, id);
  if (push) schedulePush(id);
}

// Records when a synced setting changed, so the newest edit wins across devices (see sync-core.js).
const touch = (...keys) => { for (const key of keys) progress.stamps = { ...progress.stamps, [key]: Date.now() }; };

function go(path) {
  if (location.hash === `#/${path}`) render();
  else location.hash = `#/${path}`;
}

// Each test practices with its own questions. The PSATs share the SAT's skills, so until PSAT exports are added
// they practice with the SAT's questions.
function choosePool() {
  const own = allQuestions.filter(q => examOfQuestion(q) === examId);
  const borrow = !own.length && exam.source === 'cb';
  pool = borrow ? allQuestions.filter(q => examOfQuestion(q) === 'sat') : own;
  byId = new Map(pool.map(q => [q.id, q]));
  library = { ...library, own: own.length, borrowed: borrow && pool.length > 0 };
}

function setExam(id) {
  if (!EXAMS[id] || id === examId) return;
  examId = id;
  exam = EXAMS[id];
  progress = progressByExam[id];
  store.saveExam(id);
  session = null;
  choosePool();
  toast(`Switched to ${exam.long}`);
  render();
}

const sectionCount = section => pool.filter(q => q.section === section).length;
const allResponses = () => EXAM_IDS.flatMap(id => progressByExam[id].responses);

// The streak and today's count include study on any test.
function answeredToday() {
  const today = dayKey(Date.now());
  return allResponses().filter(r => dayKey(r.at) === today).length;
}

function streakDays() {
  const days = new Set(allResponses().map(r => dayKey(r.at)));
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

function daysUntilTest() {
  if (!progress.plan.testDate) return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${progress.plan.testDate}T00:00`) - start) / DAY_MS);
}

function sectionEstimate(section) {
  const answered = progress.responses.filter(r => r.section === section).length;
  if (!progress.placement?.[section] && answered < 5) return null;
  return projectSectionScore(sectionAbility(progress, section, exam), exam.scale);
}

function projectedTotal() {
  return totalScore(exam, Object.fromEntries(scoredSections(exam).map(s => [s.id, sectionEstimate(s.id)])));
}

const totalLabel = () => exam.total.label ?? 'Estimated total';
const masteryClass = p => (p < 0.45 ? 'low' : p < 0.7 ? 'mid' : 'high');
const masteryName = p => (p < 0.45 ? 'Needs work' : p < 0.7 ? 'Building' : 'Strong');

function clock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function snippet(q) {
  const text = [q.passage, q.stem].filter(Boolean).join(' ');
  if (!text) return `Question ${q.cbId ?? q.number ?? q.id}`;
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

// Questions built from exports keep math, graphs and tables as images (see scripts/build-questions.js).
function imgHtml(image, alt) {
  if (!image?.src) return '';
  return `<img class="qimg" src="${esc(image.src)}" alt="${esc(alt)}" width="${image.width}" height="${image.height}" style="--w:${Number(image.width) || 0}px" loading="lazy">`;
}

// A typed-in answer drawn as math in the export can't be checked automatically; the student compares
// their answer with the image and marks it. Placement and timed tests only use gradable questions.
const gradable = q => q.answer != null;
const answerText = q => (Array.isArray(q.answer) ? q.answer.join(' or ') : q.answer);

// A button that needs a second click within a few seconds, instead of a blocking confirm() dialog.
function confirmButton(sel, armedLabel, action) {
  on(sel, 'click', e => {
    const b = e.currentTarget;
    if (b.dataset.armed) return action();
    const original = b.textContent;
    b.dataset.armed = '1';
    b.textContent = armedLabel;
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = original; } }, 4000);
  });
}

// A short confirmation at the bottom of the screen ("Saved", "Synced").
let toastTimer = null;
function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- routing ----------

const ROUTES = {
  home: [viewHome, 'Dashboard'], scores: [viewScores, 'Scores'], start: [viewStart, 'Get started'],
  placement: [viewPlacement, 'Placement test'], placed: [viewPlaced, 'Placement results'], practice: [viewPractice, 'Practice'],
  test: [viewTest, 'Practice test'], review: [viewReview, 'Review'], plan: [viewPlan, 'Study plan'],
  library: [viewLibrary, 'Library'], resources: [viewResources, 'Resources'], account: [viewAccount, 'Account'],
};

function render() {
  clearInterval(ticker);
  view.removeAttribute('data-loading'); // the app started, so index.html's load-error fallback stands down
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const route = ROUTES[name] ? name : 'home';
  // Leaving a running test keeps its clock going; bank the time spent and highlights on the open question.
  if (currentRoute === 'test' && route !== 'test' && test && !test.finished && !test.onBreak && $('#tq')) leaveQuestion();
  currentRoute = route;
  setMore(false);
  closePalette();
  if (!pool.length && ['practice', 'test', 'placement', 'placed'].includes(route)) return go('library');
  if (!progress.profile.mode && !['library', 'resources', 'start', 'placement', 'placed', 'account'].includes(route)) return go('start');
  if (session && !sessionBelongsTo(route)) session = null;
  document.title = `${ROUTES[route][1]} · ${exam.name} · ${APP_NAME}`;
  renderNav(route);
  window.scrollTo(0, 0);
  ROUTES[route][0](arg);
}

function sessionBelongsTo(route) {
  return { placement: 'placement', practice: 'practice', review: 'review' }[route] === session.kind;
}

const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  scores: '<path d="M5 20v-8M12 20V5M19 20v-5"/><path d="M3 20h18"/>',
  practice: '<path d="M5 19l1-4L16.5 4.5l3 3L9 18z"/><path d="m14.5 6.5 3 3"/>',
  test: '<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.5l2.5 1.5M9.5 3h5"/>',
  review: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5V9H9"/>',
  plan: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  library: '<path d="M4 5h4v14H4zM9.5 5h4v14h-4z"/><path d="m15.2 5.8 3.4-.9 2.9 13.4-3.4.9z"/>',
  resources: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chevron: '<path d="m14.5 6-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  flame: '<path d="M12 21c-3.9 0-7-2.8-7-6.6 0-2.9 1.9-5 3.6-6.8.6 2 1.8 3 3 3.4-.5-3.1.9-6 3.4-8 .4 3 2 4.6 3.3 6.3 1 1.4 1.7 3 1.7 5.1 0 3.8-3.1 6.6-7 6.6z"/>',
  more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
};
const icon = name => `<svg class="icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// The streak counts every day in a row with at least one answered question, on any test, with no upper limit.
// Progress toward today's question goal sits underneath it as a small bar.
function streakWidget(streak, today, goal, withTooltip = false) {
  const title = streak ? `${streak}-day streak` : 'No streak yet';
  const label = `${title}. ${today} of ${goal} questions today.`;
  const done = Math.min(100, Math.round((today / Math.max(1, goal)) * 100));
  return `<div class="streak${streak ? ' on' : ''}" role="img" aria-label="${label}"${withTooltip ? ` title="${label}"` : ''}>
      <span class="streak-count">${streak}</span>
      <span class="label"><strong>${title}</strong><span>${today >= goal ? `Goal met · ${today} today` : `${today} of ${goal} today`}</span><i class="goal-bar"><i style="width:${done}%"></i></i></span>
    </div>`;
}

// Every page opens with the same header: an eyebrow, the title, then the test switch, "Jump to" and page actions.
function pageHead(title, { eyebrow = '', actions = '' } = {}) {
  return `<header class="page-head">
      <div class="page-title">${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1>${title}</h1></div>
      <div class="page-tools">
        <div class="exam-switch" role="group" aria-label="Test">${EXAM_IDS.map(id => `<button type="button" data-exam="${id}" aria-pressed="${id === examId}"${id === examId ? ' class="on"' : ''} title="${esc(EXAMS[id].long)}">${EXAMS[id].name}</button>`).join('')}</div>
        <button type="button" class="jump" data-palette>${icon('search')}<span>Jump to…</span><kbd>⌘K</kbd></button>
        ${actions}
      </div>
    </header>`;
}

// The sidebar on wide screens; a top bar, bottom tabs and a "More" sheet on phones.
function renderNav(active) {
  const due = dueMistakes(progress.mistakes).filter(id => byId.has(id)).length;
  const today = answeredToday();
  const goal = progress.plan.dailyGoal;
  const testRunning = test && !test.finished;
  const sync = syncConfigured ? syncState() : null;
  const syncText = !sync ? '' : !sync.account ? 'Sign in to sync' : sync.phase === 'error' ? 'Sync problem' : sync.lastSynced ? 'Synced' : 'Syncing…';
  const syncDot = !sync?.account ? '' : sync.phase === 'error' ? 'bad' : 'ok';
  const current = r => (r === active ? ' class="on" aria-current="page"' : '');
  const badge = r => (r === 'review' && due ? `<span class="badge">${due}</span>`
    : r === 'test' && testRunning ? '<span class="badge live">In progress</span>' : '');

  const links = [['home', 'Dashboard'], ['scores', 'Scores'], ['practice', 'Practice'], ['test', 'Practice test'], ['review', 'Review'], ['plan', 'Study plan'], ['library', 'Library'], ['resources', 'Resources']];
  // Collapsed, the sidebar is a strip of icons; names move into tooltips and accessible labels.
  const collapsed = shell.classList.contains('collapsed');
  const tip = text => (collapsed ? ` title="${esc(text)}"` : '');
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const streak = streakDays();
  side.innerHTML = `
    <div class="side-head">
      <a class="brand" href="#/home">${APP_NAME}</a>
      <button type="button" class="collapse" id="collapse" aria-label="${toggleLabel}" title="${toggleLabel}" aria-expanded="${!collapsed}">${icon('chevron')}</button>
    </div>
    <nav class="side-nav" aria-label="Main">${links.map(([r, label]) => {
      const name = r === 'review' && due ? `${label}, ${due} due` : r === 'test' && testRunning ? `${label}, in progress` : label;
      return `<a href="#/${r}"${current(r)} aria-label="${name}"${tip(name)}>${icon(r)}<span class="label">${label}</span>${badge(r)}</a>`;
    }).join('')}</nav>
    ${streakWidget(streak, today, goal, collapsed)}
    ${sync ? `<a class="sync${active === 'account' ? ' on' : ''}" href="#/account" aria-label="${syncText}${sync.account ? `: ${esc(sync.account)}` : ''}"${tip(syncText)}><i class="dot ${syncDot}"></i><span class="label">${syncText}${sync.account ? `<small title="${esc(sync.account)}">${esc(sync.account)}</small>` : ''}</span></a>` : ''}`;

  topbar.innerHTML = `
    <a class="brand" href="#/home">${APP_NAME}</a>
    <a class="top-streak${streak ? ' on' : ''}" href="#/home" aria-label="${streak ? `${streak}-day streak` : 'No streak yet'}, ${today} of ${goal} questions today">${icon('flame')}<span>${streak}</span></a>
    ${sync ? `<a class="top-sync" href="#/account" aria-label="${syncText}"><i class="dot ${syncDot}"></i></a>` : ''}`;

  const tabLinks = [['home', 'Home'], ['practice', 'Practice'], ['test', 'Test'], ['review', 'Review']];
  const moreLinks = [['scores', 'Scores'], ['plan', 'Study plan'], ['library', 'Library'], ['resources', 'Resources'], ...(sync ? [['account', sync.account ? 'Account' : 'Sign in']] : [])];
  const inMore = moreLinks.some(([r]) => r === active);
  tabs.innerHTML = `${tabLinks.map(([r, label]) => `<a href="#/${r}"${current(r)}>${icon(r)}<span>${label}</span>${badge(r)}</a>`).join('')}
    <button type="button" id="more-toggle"${inMore ? ' class="on"' : ''} aria-expanded="${!more.hidden}" aria-controls="more">${icon('more')}<span>More</span></button>`;
  more.innerHTML = moreLinks.map(([r, label]) => `<a href="#/${r}"${current(r)}>${label}<span aria-hidden="true">›</span></a>`).join('');
}

function toggleSidebar() {
  const collapsed = shell.classList.toggle('collapsed');
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  renderNav(currentRoute);
  document.getElementById('collapse')?.focus();
}

function setMore(open) {
  more.hidden = !open;
  document.getElementById('more-toggle')?.setAttribute('aria-expanded', String(open));
}

// "Jump to": search pages, the current test's skills, and the other tests.
function paletteItems() {
  const pages = [['home', 'Dashboard'], ['scores', 'Scores'], ['practice', 'Practice'], ['test', 'Practice test'], ['review', 'Review'],
    ['plan', 'Study plan'], ['library', 'Library'], ['resources', 'Resources'], ...(syncConfigured ? [['account', 'Account']] : [])]
    .map(([route, label]) => ({ label, hint: 'Page', href: `#/${route}` }));
  const skills = exam.sections.flatMap(s => skillsOf(exam, s.id)
    .filter(k => pool.some(q => q.section === s.id && q.skill === k.name))
    .map(k => ({ label: k.name, hint: `Practice · ${s.name}`, skill: k.name, section: s.id })));
  const tests = EXAM_IDS.filter(id => id !== examId).map(id => ({ label: `Switch to ${EXAMS[id].long}`, hint: 'Test', exam: id }));
  return [...pages, ...skills, ...tests];
}

function openPalette() {
  let dialog = document.getElementById('palette');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'palette';
    dialog.className = 'palette';
    dialog.setAttribute('aria-label', 'Jump to');
    document.body.appendChild(dialog);
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  }
  if (dialog.open) return;
  const items = paletteItems();
  dialog.innerHTML = `<div class="palette-box">
      <input id="palette-input" type="search" placeholder="Jump to a page, skill or test" aria-label="Jump to" aria-controls="palette-list" autocomplete="off" spellcheck="false">
      <ul id="palette-list" role="listbox" aria-label="Results"></ul>
    </div>`;
  const input = dialog.querySelector('input');
  const list = dialog.querySelector('ul');
  let active = 0;
  let shown = items;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter(i => i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 12);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((i, k) => `<li role="option" id="pal-${k}" data-k="${k}" aria-selected="${k === active}"><span>${esc(i.label)}</span><small>${esc(i.hint)}</small></li>`).join('')
      : '<li class="palette-empty">No matches</li>';
    if (shown.length) input.setAttribute('aria-activedescendant', `pal-${active}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = item => {
    dialog.close();
    if (!item) return;
    if (item.exam) return setExam(item.exam);
    if (item.skill) {
      session = { kind: 'practice', section: item.section, skill: item.skill, done: 0, correct: 0, q: null };
      return go(`practice/${item.section}`);
    }
    location.hash = item.href;
  };
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]); }
  });
  list.addEventListener('click', e => {
    const li = e.target.closest('[data-k]');
    if (li) choose(shown[Number(li.dataset.k)]);
  });
  draw();
  dialog.showModal();
  input.focus();
}

function closePalette() {
  const dialog = document.getElementById('palette');
  if (dialog?.open) dialog.close();
}

document.addEventListener('click', e => {
  if (e.target.closest('#collapse')) return toggleSidebar();
  if (e.target.closest('#more-toggle')) return setMore(more.hidden);
  const examButton = e.target.closest('[data-exam]');
  if (examButton) return setExam(examButton.dataset.exam);
  if (e.target.closest('[data-palette]')) return openPalette();
  if (!more.hidden && (!e.target.closest('#more') || e.target.closest('#more a'))) setMore(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !more.hidden) setMore(false);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  }
});

// ---------- shared question rendering ----------

// A passage or figure goes in its own reading column, beside the question on wide screens like the real test.
function questionHtml(q, st = {}) {
  let reading = '';
  let prompt;
  if (q.promptImage) {
    prompt = `<div class="prompt-image">${imgHtml(q.promptImage, 'The question, as shown in the official export')}</div>`;
  } else {
    const passage = q.passage || st.passageHtml
      ? `<div class="passage">${st.passageHtml ?? para(q.passage)}</div>` : '';
    const figures = (q.figures || []).map(src => `<img class="figure" src="${esc(src)}" alt="Figure for this question">`).join('');
    if (passage || figures) reading = `<div class="q-read">${passage}${figures}</div>`;
    prompt = `<div class="stem">${para(q.stem)}</div>`;
  }
  let answer;
  if (q.choices) {
    answer = `<ol class="choices">${q.choices.map(c => {
      const cls = [
        st.selected === c.letter && 'selected',
        st.eliminated?.has(c.letter) && 'eliminated',
        st.revealed && c.letter === q.answer && 'correct',
        st.revealed && st.selected === c.letter && c.letter !== q.answer && 'wrong',
      ].filter(Boolean).join(' ');
      const tag = !st.revealed ? ''
        : c.letter === q.answer ? '<span class="tag ok">✓ Correct answer</span>'
        : st.selected === c.letter ? '<span class="tag bad">✗ Your answer</span>' : '';
      return `<li class="${cls}" data-letter="${c.letter}">
        <button class="choice-btn" data-choice="${c.letter}" ${st.revealed ? 'disabled' : ''}><span class="letter">${c.letter}</span>${c.image ? imgHtml(c.image, `Choice ${c.letter}`) : `<span>${inline(c.text)}</span>`}${tag}</button>
        ${st.tools ? `<button class="strike" data-strike="${c.letter}" title="Cross out choice ${c.letter}" aria-label="Cross out choice ${c.letter}">✕</button>` : ''}
      </li>`;
    }).join('')}</ol>`;
  } else {
    answer = `<label class="spr">Your answer
      <input data-spr value="${esc(st.selected ?? '')}" ${st.revealed ? 'disabled' : ''} autocomplete="off" spellcheck="false" placeholder="e.g. 12, 3/4, -2.5">
    </label>`;
  }
  let feedback = '';
  if (st.revealed) {
    const key = gradable(q)
      ? `The answer is ${esc(answerText(q))}.`
      : `<div class="answer-image">The correct answer: ${imgHtml(q.answerImage, 'The correct answer')}</div>`;
    const rationale = q.rationaleImage ? imgHtml(q.rationaleImage, 'Explanation') : q.rationale ? para(q.rationale) : '';
    feedback = st.correct == null
      ? `<div class="feedback pending"><strong>Compare your answer.</strong> ${key}
          <div class="actions"><button class="primary" data-self="1">I got it right</button><button data-self="0">I got it wrong</button></div></div>`
      : `<div class="feedback ${st.correct ? 'ok' : 'bad'}"><strong>${st.correct ? '✓ Correct.' : '✗ Not quite.'}</strong> ${key}
          ${rationale ? `<div class="rationale">${rationale}</div>` : ''}</div>`;
  }
  const original = st.revealed && q.original
    ? `<details class="original"><summary>View the original from the export</summary>${imgHtml(q.original, 'The original question')}</details>` : '';
  const meta = st.hideMeta ? '' : `<div class="meta">${esc(q.domain)} · ${esc(q.skill)}${q.difficulty ? ` · ${esc(q.difficulty)}` : ''}${q.source === 'demo' ? ' · demo' : ''}</div>`;
  return `<article class="question${reading ? ' split' : ''}">${meta}${reading}<div class="q-work">${prompt}${answer}${feedback}${original}</div></article>`;
}

// Wires up choice selection, crossing out and typed answers without re-rendering (so highlights survive).
function bindAnswerInputs(onChange, eliminated) {
  view.querySelectorAll('.choice-btn').forEach(btn => btn.addEventListener('click', () => {
    const letter = btn.dataset.choice;
    if (eliminated?.has(letter)) {
      eliminated.delete(letter);
      btn.closest('li').classList.remove('eliminated');
    }
    view.querySelectorAll('.choices li').forEach(li => li.classList.toggle('selected', li.dataset.letter === letter));
    onChange(letter);
  }));
  view.querySelectorAll('[data-strike]').forEach(b => b.addEventListener('click', () => {
    const letter = b.dataset.strike;
    const li = b.closest('li');
    if (eliminated.has(letter)) eliminated.delete(letter); else eliminated.add(letter);
    li.classList.toggle('eliminated', eliminated.has(letter));
    if (eliminated.has(letter) && li.classList.contains('selected')) {
      li.classList.remove('selected');
      onChange(null);
    }
  }));
  const input = view.querySelector('[data-spr]');
  if (input) {
    input.addEventListener('input', () => onChange(input.value.trim() || null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') view.querySelector('.actions .primary:not(:disabled)')?.click(); });
  }
}

function record(q, choice, source, ms, selfMarked) {
  const correct = selfMarked ?? isCorrect(q, choice);
  progress.responses.push({
    qid: q.id, section: q.section, domain: q.domain, skill: q.skill, b: DIFFICULTY_B[q.difficulty] ?? 0,
    correct, choice: choice ?? null, ms, at: Date.now(), source,
  });
  if (source === 'review') reviewMistake(progress.mistakes, q.id, correct);
  else if (!correct) addMistake(progress.mistakes, q.id, progress.mistakes[q.id]?.reason ?? null);
  save();
  return correct;
}

function reasonPicker(qid) {
  const current = progress.mistakes[qid]?.reason;
  return `<div class="reasons"><span>Why did you miss it?</span>${MISTAKE_REASONS.map(r =>
    `<button class="chip ${r === current ? 'active' : ''}" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>`;
}

function bindReasonPicker(qid) {
  on('[data-reason]', 'click', e => {
    if (!progress.mistakes[qid]) return;
    progress.mistakes[qid].reason = e.currentTarget.dataset.reason;
    progress.mistakes[qid].updatedAt = Date.now();
    save();
    view.querySelectorAll('[data-reason]').forEach(b => b.classList.toggle('active', b === e.currentTarget));
  });
}

const newDrillState = () => ({ selected: null, eliminated: new Set(), revealed: false, correct: null, shownAt: Date.now() });

// One-question-at-a-time flow with instant feedback, shared by practice and review.
function renderDrill(headerHtml, source, rerender) {
  const { q, st } = session;
  const awaitingSelfMark = st.revealed && st.correct == null;
  view.innerHTML = `${headerHtml}
    ${questionHtml(q, { ...st, tools: !st.revealed })}
    ${st.correct === false ? reasonPicker(q.id) : ''}
    <div class="actions">${awaitingSelfMark ? ''
      : st.revealed ? '<button class="primary" id="next">Next question</button>'
      : `<button class="primary" id="check" ${st.selected == null ? 'disabled' : ''}>Check answer</button>`}</div>`;

  const finish = correct => {
    st.correct = record(q, st.selected, source, Date.now() - st.shownAt, correct);
    session.done++;
    if (st.correct) session.correct++;
  };

  if (!st.revealed) {
    bindAnswerInputs(v => { st.selected = v; $('#check').disabled = v == null; }, st.eliminated);
    on('#check', 'click', () => {
      st.revealed = true;
      if (gradable(q)) finish();
      rerender();
    });
  } else if (awaitingSelfMark) {
    on('[data-self]', 'click', e => { finish(e.currentTarget.dataset.self === '1'); rerender(); });
  } else {
    bindReasonPicker(q.id);
    on('#next', 'click', () => { session.q = null; rerender(); window.scrollTo(0, 0); });
    $('#next').focus({ preventScroll: true }); // keep the marked choices in view
  }
}

// ---------- start: placement or grade ----------

function addQuestionsHint() {
  // Still being built: the reader for ACT's official practice test PDFs.
  return exam.source === 'act'
    ? 'wait for the next update: ACT support is still being built, and official ACT practice tests can’t be loaded yet'
    : `save ${exam.long} exports from the College Board Question Bank in the <code>exports</code> folder and restart the app`;
}

function viewStart() {
  const placementSections = scoredSections(exam);
  const small = placementSections.some(s => sectionCount(s.id) < 15);
  view.innerHTML = `
    ${pageHead('How should we find your level?', { eyebrow: exam.long })}
    <p class="muted">Either way, practice keeps adapting to how you actually do. You can change this later.</p>
    ${syncConfigured && !syncState().account ? '<p class="note">Already studying on another device? <a href="#/account">Sign in</a> to bring your progress here.</p>' : ''}
    <div class="cards">
      <div class="card">
        <h2>Take the placement test</h2>
        <p>About ${PLACEMENT.minItems}–${PLACEMENT.maxItems} questions in each of ${placementSections.map(s => s.name).join(', ')}. Questions get harder or easier as you answer, and you'll get an estimated score range and a skill breakdown. Answers aren't shown during the test; any misses go to your Review list.</p>
        <button class="primary" id="placement" ${pool.length ? '' : 'disabled'}>Start placement test</button>
      </div>
      <div class="card">
        <h2>Choose your grade</h2>
        <p>Start at a typical level for your grade. Skills usually taught in later courses are held back until you take the placement test.</p>
        <div class="actions">
          <select id="grade" aria-label="Grade">${exam.grades.map(g => `<option value="${g}" ${progress.profile.grade === g ? 'selected' : ''}>Grade ${g}</option>`).join('')}</select>
          <button id="use-grade">Use this grade</button>
        </div>
      </div>
    </div>
    ${!pool.length ? `<p class="note">There are no ${exam.name} questions yet. To add them, ${addQuestionsHint()}.</p>`
      : library.borrowed ? `<p class="note">No ${exam.long} questions have been added yet, so practice uses SAT questions, which cover the same skills. To add ${exam.name} questions, ${addQuestionsHint()}.</p>`
      : small ? `<p class="note">Your ${exam.name} library is small (${placementSections.map(s => `${sectionCount(s.id)} ${s.name}`).join(', ')}), so placement results will be rough until you add more questions.</p>` : ''}`;
  on('#placement', 'click', () => {
    progress.profile.mode = 'placement';
    progress.placement = {};
    touch('profile', 'placement');
    save();
    session = null;
    go(`placement/${placementSections[0].id}`);
  });
  on('#use-grade', 'click', () => {
    progress.profile = { mode: 'grade', grade: Number($('#grade').value) };
    progress.placement = {};
    touch('profile', 'placement');
    save();
    toast('Saved');
    go('home');
  });
}

function viewPlacement(arg) {
  const sections = scoredSections(exam);
  const section = sections.some(s => s.id === arg) ? arg : sections[0].id;
  if (session?.kind !== 'placement' || session.section !== section) {
    session = { kind: 'placement', section, answered: [], q: null };
  }
  if (!session.q) {
    const step = nextPlacementQuestion(pool.filter(gradable), session.answered, section);
    if (step.done) return finishPlacement(section, step.estimate);
    session.q = step.question;
    session.st = newDrillState();
  }
  const { q, st } = session;
  view.innerHTML = `
    <header class="bar">
      <div><div class="eyebrow">Placement test · ${exam.name} · ${sectionName(section)}</div>
      <strong>Question ${session.answered.length + 1}</strong> <span class="muted">of at most ${PLACEMENT.maxItems}</span></div>
      <button class="ghost small" id="skip">${session.answered.length ? 'Finish this section now' : 'Skip this section'}</button>
    </header>
    ${questionHtml(q, { ...st, tools: true, hideMeta: true })}
    <div class="actions"><button class="primary" id="submit" disabled>Next</button></div>`;
  bindAnswerInputs(v => { st.selected = v; $('#submit').disabled = v == null; }, st.eliminated);
  on('#submit', 'click', () => {
    const correct = record(q, st.selected, 'placement', Date.now() - st.shownAt);
    session.answered.push({ qid: q.id, domain: q.domain, b: DIFFICULTY_B[q.difficulty] ?? 0, correct });
    session.q = null;
    viewPlacement(section);
    window.scrollTo(0, 0);
  });
  on('#skip', 'click', () => finishPlacement(section, session.answered.length ? estimateAbility(session.answered) : null));
}

function finishPlacement(section, estimate) {
  if (estimate && session.answered.length) {
    progress.placement = { ...progress.placement, [section]: { theta: estimate.theta, se: estimate.se, items: session.answered.length, finishedAt: Date.now() } };
    touch('placement');
    save();
  }
  session = null;
  const sections = scoredSections(exam).map(s => s.id);
  const next = sections[sections.indexOf(section) + 1];
  go(next ? `placement/${next}` : 'placed');
}

function viewPlaced() {
  const sections = scoredSections(exam);
  const placed = sections.filter(s => progress.placement?.[s.id]);
  if (!placed.length) {
    view.innerHTML = `${pageHead('Placement results', { eyebrow: exam.long })}<div class="empty"><h2>No placement results</h2><p>Every section was skipped. Choose a grade instead, or retake the placement test.</p><a class="button primary" href="#/start">Back</a></div>`;
    return;
  }
  const answers = placed.flatMap(s => progress.responses
    .filter(r => r.source === 'placement' && r.section === s.id).slice(-progress.placement[s.id].items));
  const byDomain = exam.domains.map(d => {
    const rs = answers.filter(r => r.domain === d.name);
    return { d, correct: rs.filter(r => r.correct).length, total: rs.length };
  }).filter(x => x.total);
  const scores = Object.fromEntries(placed.map(s => [s.id, projectSectionScore(progress.placement[s.id], exam.scale)]));
  const total = totalScore(exam, scores);
  view.innerHTML = `
    ${pageHead('Placement results', { eyebrow: exam.long })}
    <div class="cards">
      ${sections.map(s => `<div class="card"><div class="eyebrow">${s.name}</div>
        ${scores[s.id] ? `<div class="big">${scores[s.id].mid}</div><div class="range">likely ${range(scores[s.id])} · ${plural(progress.placement[s.id].items, 'question')}</div>` : '<p class="muted">Skipped</p>'}</div>`).join('')}
      ${total ? `<div class="card"><div class="eyebrow">${totalLabel()}</div><div class="big">${total.mid}</div><div class="range">likely ${range(total)}</div></div>` : ''}
    </div>
    <div class="card">
      <h2>By domain</h2>
      <div class="table-wrap"><table><thead><tr><th>Domain</th><th class="num">Correct</th></tr></thead>
      <tbody>${byDomain.map(x => `<tr><td>${esc(x.d.name)}</td><td class="num">${x.correct} / ${x.total}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <p class="note">These ranges are estimates based on your answers and each question's difficulty. They are not official ${exam.maker} scores, and they get sharper as you keep practicing.</p>
    <div class="actions"><a class="button primary" href="#/practice">Start practicing</a><a class="button" href="#/home">Go to dashboard</a></div>`;
}

// ---------- practice ----------

function viewPractice(arg) {
  const section = sectionOf(exam, arg) ? arg : session?.kind === 'practice' ? session.section : exam.sections[0].id;
  if (session?.kind !== 'practice' || session.section !== section) {
    session = { kind: 'practice', section, skill: '', done: 0, correct: 0, q: null };
  }
  if (!session.q) {
    session.q = nextPracticeQuestion(pool, progress, section, { skill: session.skill || undefined, exam });
    session.st = newDrillState();
  }
  const skills = skillsOf(exam, section).filter(s => pool.some(q => q.section === section && q.skill === s.name));
  const header = `
    ${pageHead('Practice', { eyebrow: `${exam.long} · adaptive practice` })}
    <div class="bar">
      <div class="seg">${exam.sections.map(s => `<a href="#/practice/${s.id}" class="${s.id === section ? 'active' : ''}">${s.name}</a>`).join('')}</div>
      <select id="skill" aria-label="Skill">
        <option value="">Adaptive: focus on weak spots</option>
        ${skills.map(s => `<option ${s.name === session.skill ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
      <span class="tally">${session.correct}/${session.done} this session · ${answeredToday()}/${progress.plan.dailyGoal} today</span>
    </div>`;
  if (!session.q) {
    view.innerHTML = `${header}<div class="empty"><h2>No ${sectionName(section)} questions available</h2><p>To add some, ${addQuestionsHint()}${progress.profile.mode === 'grade' ? ', or take the placement test to unlock skills beyond your grade' : ''}.</p><a class="button primary" href="#/library">Open Library</a></div>`;
  } else {
    renderDrill(header, 'practice', () => viewPractice(section));
  }
  on('#skill', 'change', e => { session.skill = e.target.value; session.q = null; viewPractice(section); });
}

// ---------- review ----------

function viewReview(arg) {
  if (arg === 'go') return reviewSession();
  session = null;
  const entries = Object.entries(progress.mistakes).filter(([id, m]) => byId.has(id) && !m.graduated).sort((a, b) => a[1].due - b[1].due);
  const due = entries.filter(([, m]) => m.due <= Date.now()).length;
  const reasons = {};
  for (const [, m] of entries) reasons[m.reason || 'Not tagged'] = (reasons[m.reason || 'Not tagged'] || 0) + 1;
  const maxReason = Math.max(1, ...Object.values(reasons));
  view.innerHTML = `
    ${pageHead('Review', { eyebrow: `${exam.long} · mistake log`, actions: `<button class="primary" id="go" ${due ? '' : 'disabled'}>Review ${plural(due, 'question')}</button>` })}
    <div class="cards">
      <div class="card"><div class="big">${due}</div><div class="muted">due now</div></div>
      <div class="card"><div class="big">${entries.length}</div><div class="muted">in your mistake log. Each one comes back after 1, 3, 7, 14 and 30 days until you've answered it right five times in a row.</div></div>
      <div class="card"><h3>Why you miss questions</h3>
        ${entries.length ? Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `
          <div class="skill-row"><span class="name">${esc(r)}</span><div class="track"><div class="fill" style="width:${(n / maxReason) * 100}%"></div></div><span class="pct">${n}</span></div>`).join('')
          : '<p class="muted">Nothing yet.</p>'}
      </div>
    </div>
    ${entries.length ? `<div class="card"><h2>Mistake log</h2><div class="table-wrap"><table class="stack">
      <thead><tr><th>Question</th><th>Skill</th><th>Difficulty</th><th>Reason</th><th>Next review</th></tr></thead>
      <tbody>${entries.map(([id, m]) => {
        const q = byId.get(id);
        return `<tr><td>${esc(snippet(q))}</td><td data-label="Skill">${esc(q.skill)}</td><td data-label="Difficulty">${esc(q.difficulty || '—')}</td><td data-label="Reason">${esc(m.reason || '—')}</td><td data-label="Next review">${m.due <= Date.now() ? 'Now' : new Date(m.due).toLocaleDateString()}</td></tr>`;
      }).join('')}</tbody></table></div></div>` : ''}`;
  on('#go', 'click', () => go('review/go'));
}

function reviewSession() {
  if (session?.kind !== 'review') {
    session = { kind: 'review', queue: dueMistakes(progress.mistakes).filter(id => byId.has(id)), done: 0, correct: 0, q: null };
  }
  if (!session.q) {
    const id = session.queue.shift();
    if (!id) {
      view.innerHTML = `${pageHead('Review', { eyebrow: exam.long })}<div class="empty"><h2>Review complete</h2><p>${session.correct} of ${session.done} correct. Questions you got right come back later; misses return tomorrow.</p><a class="button primary" href="#/home">Back to dashboard</a></div>`;
      session = null;
      renderNav('review');
      return;
    }
    session.q = byId.get(id);
    session.st = newDrillState();
  }
  const header = `<header class="bar"><div><div class="eyebrow">Review · ${exam.name}</div><strong>${plural(session.queue.length + 1, 'question')} left</strong></div><span class="tally">${session.correct}/${session.done} correct</span></header>`;
  renderDrill(header, 'review', reviewSession);
}

// ---------- timed practice test ----------

const testableCount = section => pool.filter(q => q.section === section && gradable(q)).length;
const hours = minutes => (minutes >= 60 ? `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`);
const sectionMinutes = list => list.reduce((sum, s) => sum + s.minutes * s.modules, 0);

function viewTest() {
  if (test && test.exam !== examId) {
    const other = EXAMS[test.exam];
    view.innerHTML = `
      ${pageHead('Practice test', { eyebrow: exam.long })}
      <div class="empty"><h2>Your ${other.name} practice test is still running</h2>
        <p>Its timer keeps going. Switch back to ${other.long} to finish it, or end it here.</p>
        <div class="actions"><button class="primary" data-exam="${test.exam}">Switch to ${other.name}</button><button id="end-test">End that test</button></div></div>`;
    confirmButton('#end-test', 'Click again to end it', () => { test = null; render(); });
    return;
  }
  if (test) {
    if (test.finished) return testResults();
    if (test.onBreak) return moduleBreak();
    return testScreen();
  }
  const scored = scoredSections(exam);
  const kinds = [
    ['FULL', `Full ${exam.name}`, scored.map(s => s.name).join(', then '), sectionMinutes(scored), scored],
    ...exam.sections.map(s => [s.id, s.name, s.modules > 1 ? 'Two modules' : `${s.perModule} questions${s.optional ? ' · optional' : ''}`, sectionMinutes([s]), [s]]),
  ];
  const intro = exam.adaptive
    ? `Built like the digital ${exam.name}. Each section has two modules. Module 1 mixes easy, medium and hard questions, and how you do on it decides whether module 2 is harder or easier. ${exam.sections.map(s => `${s.name} modules are ${s.perModule} questions in ${s.minutes} minutes`).join('; ')}.`
    : `Built like the ${exam.name}: each section is one timed block, in test-day order. ${exam.sections.map(s => `${s.name} is ${s.perModule} questions in ${s.minutes} minutes`).join('; ')}.${exam.sections.some(s => s.optional) ? ` ${exam.sections.filter(s => s.optional).map(s => s.name).join(' and ')} is optional and isn't part of the ${totalLabel()}.` : ''}`;
  const short = exam.sections.filter(s => testableCount(s.id) < s.perModule * s.modules);
  view.innerHTML = `
    ${pageHead('Timed practice test', { eyebrow: exam.long })}
    <p class="lede">${intro}</p>
    <div class="cards">
      ${kinds.map(([k, title, sub, minutes, list]) => `
        <div class="card"><h2>${title}</h2><p class="muted">${sub} · ${hours(minutes)}</p><button class="primary" data-test="${k}" ${list.every(s => testableCount(s.id)) ? '' : 'disabled'}>Start</button></div>`).join('')}
    </div>
    ${short.length ? `<p class="note">A full-length test needs ${short.map(s => `${s.perModule * s.modules} ${s.name}`).join(', ')} questions that can be scored automatically. You have ${short.map(s => `${testableCount(s.id)} ${s.name}`).join(', ')}, so sections will be shorter until you add more.</p>` : ''}
    ${progress.tests.length ? `<div class="card"><h2>Past tests</h2><div class="table-wrap"><table class="stack">
      <thead><tr><th>Date</th><th>Test</th>${scored.map(s => `<th>${s.name}</th>`).join('')}<th>${totalLabel()}</th></tr></thead>
      <tbody>${[...progress.tests].reverse().map(t => `<tr><td>${new Date(t.at).toLocaleDateString()}</td><td data-label="Test">${esc(t.kind)}</td>
        ${scored.map(s => `<td data-label="${s.name}">${t.summary[s.id] ? `${t.summary[s.id].score.mid} <span class="muted">(${t.summary[s.id].correct}/${t.summary[s.id].total})</span>` : '—'}</td>`).join('')}
        <td data-label="${totalLabel()}">${t.total ? t.total.mid : '—'}</td></tr>`).join('')}</tbody>
    </table></div></div>` : ''}`;
  on('[data-test]', 'click', e => startTest(e.currentTarget.dataset.test));
}

function startTest(kind) {
  test = {
    exam: examId,
    sections: kind === 'FULL' ? scoredSections(exam).map(s => s.id) : [kind], sIdx: 0, module: 1, route: null, used: new Set(), results: [],
    panel: null, hideTimer: false, seenBefore: new Set(progress.responses.map(r => r.qid)),
  };
  startModule();
  beginModule();
}

function startModule() {
  const s = test;
  const section = s.sections[s.sIdx];
  const format = sectionOf(exam, section);
  const usable = pool.filter(q => q.section === section && gradable(q));
  // A small library is split between a section's modules, so an adaptive module 2 still has questions to route to.
  const size = Math.min(format.perModule, Math.ceil(usable.length / format.modules));
  // Prefer questions not seen before this test, decided the same way for every module.
  const unseen = usable.filter(q => !s.seenBefore.has(q.id));
  const source = unseen.length >= size * format.modules ? unseen : usable;
  const questions = buildModule(source, section, s.module === 1 ? null : s.route, s.used, size, exam);
  questions.forEach(q => s.used.add(q.id));
  Object.assign(s, { section, questions, idx: 0, answers: {}, eliminated: {}, flags: new Set(), highlights: {}, times: {}, reviewScreen: false, gridOpen: false, highlightMode: false });
}

function beginModule() {
  const s = test;
  s.onBreak = false;
  s.endsAt = Date.now() + sectionOf(exam, s.section).minutes * 60 * 1000;
  renderNav('test');
  testScreen();
}

function testScreen() {
  const s = test;
  const format = sectionOf(exam, s.section);
  const short = s.questions.length < format.perModule;
  const toolButton = (tool, label, attrs) => (format.tools.includes(tool) ? `<button class="ghost small ${attrs.active ? 'active' : ''}" ${attrs.html}>${label}</button>` : '');
  view.innerHTML = `
    <div class="test ${s.highlightMode ? 'highlighting' : ''}">
      <header class="test-bar">
        <div><strong>${format.name}</strong>${format.modules > 1 ? ` · Module ${s.module}` : ''}${short ? ` <span class="muted">(${plural(s.questions.length, 'question')})</span>` : ''}</div>
        <div><span id="timer" class="timer ${s.hideTimer ? 'concealed' : ''}"></span><button class="ghost small" id="toggle-timer">${s.hideTimer ? 'Show timer' : 'Hide'}</button></div>
        <div class="tools">
          ${toolButton('highlighter', 'Highlighter', { active: s.highlightMode, html: 'id="hl"' })}
          ${toolButton('calculator', 'Calculator', { active: s.panel === 'calc', html: 'data-panel="calc"' })}
          ${toolButton('reference', 'Reference', { active: s.panel === 'ref', html: 'data-panel="ref"' })}
        </div>
      </header>
      <div class="test-body ${s.panel ? 'with-panel' : ''}">
        <div id="tq"></div>
        <aside class="panel" id="panel" ${s.panel ? '' : 'hidden'}></aside>
      </div>
    </div>`;
  on('#toggle-timer', 'click', e => {
    s.hideTimer = !s.hideTimer;
    $('#timer').classList.toggle('concealed', s.hideTimer);
    e.currentTarget.textContent = s.hideTimer ? 'Show timer' : 'Hide';
  });
  on('#hl', 'click', e => {
    s.highlightMode = !s.highlightMode;
    e.currentTarget.classList.toggle('active', s.highlightMode);
    view.querySelector('.test').classList.toggle('highlighting', s.highlightMode);
  });
  on('[data-panel]', 'click', e => {
    const which = e.currentTarget.dataset.panel;
    s.panel = s.panel === which ? null : which;
    view.querySelectorAll('[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === s.panel));
    view.querySelector('.test-body').classList.toggle('with-panel', !!s.panel);
    drawPanel();
  });
  drawPanel();
  s.shownAt = Date.now();
  drawQuestion();
  // Draw first: if time ran out while the student was on another page, tick submits the module right away.
  ticker = setInterval(tick, 1000);
  tick();
}

function tick() {
  if (!test || test.finished || test.onBreak || test.exam !== examId) return clearInterval(ticker);
  const left = test.endsAt - Date.now();
  const timer = document.getElementById('timer');
  if (timer) {
    timer.textContent = clock(left);
    timer.classList.toggle('warn', left <= 5 * 60 * 1000);
  }
  if (left <= 0) submitModule();
}

function drawPanel() {
  const panel = $('#panel');
  if (!panel) return;
  panel.hidden = !test.panel;
  if (test.panel === 'calc') mountCalculator(panel, () => test?.panel === 'calc' && panel.isConnected);
  else if (test.panel === 'ref') panel.innerHTML = REFERENCE_SHEET;
  else panel.innerHTML = '';
}

function leaveQuestion() {
  const s = test;
  const q = s.questions[s.idx];
  if (s.reviewScreen || !q) return;
  s.times[q.id] = (s.times[q.id] || 0) + Date.now() - s.shownAt;
  const passage = view.querySelector('.passage');
  if (passage) s.highlights[q.id] = passage.innerHTML;
}

function goToQuestion(i) {
  leaveQuestion();
  Object.assign(test, { idx: i, reviewScreen: false, gridOpen: false, shownAt: Date.now() });
  drawQuestion();
  window.scrollTo(0, 0);
}

function drawQuestion() {
  const s = test;
  const tq = $('#tq');
  const unit = sectionOf(exam, s.section).modules > 1 ? 'module' : 'section';
  if (s.reviewScreen) {
    const unanswered = s.questions.filter(q => s.answers[q.id] == null).length;
    tq.innerHTML = `
      <div class="card">
        <h2>Check your work</h2>
        <p>${unanswered ? `<span class="warn">${plural(unanswered, 'question')} unanswered.</span> ` : 'Every question has an answer. '}${s.flags.size ? `${plural(s.flags.size, 'question')} flagged for review. ` : ''}Pick a question to revisit it, or submit the ${unit}. You can't come back to this ${unit} after submitting.</p>
        ${gridHtml()}
        <div class="actions"><button id="back-to-q">Back to questions</button><button class="primary" id="submit-module">Submit ${unit}</button></div>
      </div>`;
    bindGrid();
    on('#back-to-q', 'click', () => goToQuestion(s.questions.length - 1));
    confirmButton('#submit-module', 'Click again to submit', submitModule);
    return;
  }
  const q = s.questions[s.idx];
  const eliminated = (s.eliminated[q.id] ||= new Set());
  const last = s.idx === s.questions.length - 1;
  tq.innerHTML = `
    <div class="q-top">
      <span class="qnum">${s.idx + 1}</span>
      <button class="ghost small flag ${s.flags.has(q.id) ? 'on' : ''}" id="flag">${s.flags.has(q.id) ? '⚑ Flagged' : '⚐ Flag for review'}</button>
    </div>
    ${questionHtml(q, { selected: s.answers[q.id], eliminated, tools: true, hideMeta: true, passageHtml: s.highlights[q.id] })}
    <div class="test-foot">
      <button id="prev" ${s.idx === 0 ? 'disabled' : ''}>Back</button>
      <button class="ghost" id="grid-toggle">Question ${s.idx + 1} of ${s.questions.length} ${s.gridOpen ? '▾' : '▴'}</button>
      <button class="primary" id="next">${last ? `Review ${unit}` : 'Next'}</button>
    </div>
    ${s.gridOpen ? gridHtml() : ''}`;
  bindAnswerInputs(v => {
    if (v == null) delete s.answers[q.id]; else s.answers[q.id] = v;
  }, eliminated);
  on('#flag', 'click', e => {
    if (s.flags.has(q.id)) s.flags.delete(q.id); else s.flags.add(q.id);
    e.currentTarget.classList.toggle('on', s.flags.has(q.id));
    e.currentTarget.textContent = s.flags.has(q.id) ? '⚑ Flagged' : '⚐ Flag for review';
  });
  on('#prev', 'click', () => goToQuestion(s.idx - 1));
  on('#next', 'click', () => {
    if (!last) return goToQuestion(s.idx + 1);
    leaveQuestion();
    s.reviewScreen = true;
    drawQuestion();
  });
  on('#grid-toggle', 'click', () => { leaveQuestion(); s.shownAt = Date.now(); s.gridOpen = !s.gridOpen; drawQuestion(); });
  bindGrid();
  bindHighlighter();
}

function gridHtml() {
  const s = test;
  return `<div class="grid" role="navigation" aria-label="Questions">${s.questions.map((q, i) => {
    const cls = [s.answers[q.id] != null && 'answered', s.flags.has(q.id) && 'flagged', !s.reviewScreen && i === s.idx && 'current'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-goto="${i}">${i + 1}</button>`;
  }).join('')}</div><p class="legend">Shaded: answered · ⚑ flagged</p>`;
}

function bindGrid() {
  on('[data-goto]', 'click', e => goToQuestion(Number(e.currentTarget.dataset.goto)));
}

function bindHighlighter() {
  const passage = view.querySelector('.passage');
  if (!passage) return;
  const highlightSelection = () => {
    if (!test.highlightMode) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const selected = sel.getRangeAt(0);
    if (!passage.contains(selected.commonAncestorContainer)) return;
    try {
      selected.surroundContents(document.createElement('mark'));
    } catch {
      // Selections that cross paragraph boundaries can't be wrapped in a single element.
    }
    sel.removeAllRanges();
  };
  passage.addEventListener('mouseup', highlightSelection);
  // On touch screens the selection is final only once the finger lifts.
  passage.addEventListener('touchend', () => setTimeout(highlightSelection, 0));
  passage.addEventListener('click', e => {
    if (test.highlightMode && e.target.tagName === 'MARK') e.target.replaceWith(...e.target.childNodes);
  });
}

function submitModule() {
  const s = test;
  if (!s || s.finished || s.onBreak) return;
  clearInterval(ticker);
  leaveQuestion();
  const format = sectionOf(exam, s.section);
  const responses = s.questions.map(q => {
    const choice = s.answers[q.id] ?? null;
    const correct = record(q, choice, 'test', s.times[q.id] || 0);
    return { qid: q.id, correct, choice, domain: q.domain, b: DIFFICULTY_B[q.difficulty] ?? 0 };
  });
  s.results.push({ section: s.section, module: s.module, route: s.module === 2 ? s.route : null, responses });
  if (format.modules > 1 && s.module === 1) {
    s.route = routeFor(responses);
    s.module = 2;
  } else {
    s.sIdx++;
    s.module = 1;
    s.route = null;
  }
  if (s.sIdx >= s.sections.length) return finishTest();
  startModule();
  // Too few questions left for this module (a small library): skip straight past it.
  if (!s.questions.length) return submitModule();
  s.onBreak = true;
  moduleBreak();
}

function moduleBreak() {
  const s = test;
  const format = sectionOf(exam, s.section);
  const newSection = s.module === 1;
  const nextLabel = `${format.name}${format.modules > 1 ? `, module ${s.module}` : ''}`;
  const why = !newSection ? 'Module 2 has been chosen based on your module 1 results.'
    : exam.adaptive ? 'On the real test there is a 10-minute break between sections.'
    : 'On test day the next section follows right after.';
  view.innerHTML = `<div class="empty">
    <h2>${newSection ? 'Section complete' : 'Module 1 complete'}</h2>
    <p>Up next: <strong>${nextLabel}</strong> · ${plural(s.questions.length, 'question')} · ${format.minutes} minutes.</p>
    <p class="muted">${why} The timer starts when you continue.</p>
    <button class="primary" id="continue">Continue</button></div>`;
  on('#continue', 'click', beginModule);
}

function finishTest() {
  const s = test;
  const summary = {};
  for (const section of s.sections) {
    const rs = s.results.filter(r => r.section === section).flatMap(r => r.responses);
    if (!rs.length) continue;
    summary[section] = {
      correct: rs.filter(r => r.correct).length,
      total: rs.length,
      route: s.results.find(r => r.section === section && r.module === 2 && r.responses.length)?.route ?? null,
      score: projectSectionScore(estimateAbility(rs), exam.scale),
    };
  }
  const full = scoredSections(exam).every(sec => s.sections.includes(sec.id));
  s.record = {
    id: `t${Date.now()}`, at: Date.now(), kind: full ? `Full ${exam.name}` : sectionName(s.sections[0]), summary,
    total: full ? totalScore(exam, Object.fromEntries(Object.entries(summary).map(([id, x]) => [id, x.score]))) : null,
    qids: s.results.flatMap(r => r.responses.map(x => x.qid)),
  };
  progress.tests.push(s.record);
  save();
  s.finished = true;
  renderNav('test');
  testResults();
}

function testResults() {
  const s = test;
  const { summary, total } = s.record;
  const all = s.results.flatMap(r => r.responses.map(x => ({ ...x, section: r.section, module: r.module })));
  const domainRows = exam.domains.map(d => {
    const rs = all.filter(r => r.domain === d.name);
    return rs.length ? `<tr><td>${esc(d.name)}</td><td class="num">${rs.filter(r => r.correct).length} / ${rs.length}</td></tr>` : '';
  }).join('');
  view.innerHTML = `
    ${pageHead('Test results', { eyebrow: `${exam.long} · ${esc(s.record.kind)}` })}
    <div class="cards">
      ${Object.entries(summary).map(([sec, x]) => `<div class="card"><div class="eyebrow">${sectionName(sec)}</div>
        <div class="big">${x.score.mid}</div><div class="range">likely ${range(x.score)}</div>
        <p class="muted">${x.correct} of ${x.total} correct${x.route ? ` · you were routed to the ${x.route === 'hard' ? 'harder' : 'easier'} module 2` : ''}</p></div>`).join('')}
      ${total ? `<div class="card"><div class="eyebrow">${totalLabel()}</div><div class="big">${total.mid}</div><div class="range">likely ${range(total)}</div></div>` : ''}
    </div>
    <div class="card"><h2>By domain</h2><div class="table-wrap"><table><tbody>${domainRows}</tbody></table></div></div>
    <p class="note">Scores are estimates from your answers and question difficulty, not ${exam.maker}'s official scoring. Missed questions have been added to Review.</p>
    <h2>Every question</h2>
    ${all.map((r, i) => {
      const q = byId.get(r.qid);
      if (!q) return '';
      const where = `${sectionShort(r.section)}${sectionOf(exam, r.section).modules > 1 ? ` M${r.module}` : ''}`;
      return `<details class="review-item"><summary><span class="${r.correct ? 'mark-ok' : 'mark-bad'}">${r.correct ? '✓' : '✗'}</span>
        <span>${i + 1}. ${where} · ${esc(q.skill)}${q.difficulty ? ` · ${q.difficulty}` : ''}${r.choice == null ? ' · <span class="warn">unanswered</span>' : ''}</span></summary>
        ${questionHtml(q, { selected: r.choice, revealed: true, correct: r.correct, hideMeta: true })}</details>`;
    }).join('')}
    <div class="actions"><button class="primary" id="done">Done</button></div>`;
  on('#done', 'click', () => { test = null; go('scores'); });
}

const REFERENCE_SHEET = `<div class="ref"><h3>Formulas</h3><p class="hint">Modeled on the SAT Suite math reference sheet.</p><dl>
  <dt>Circle</dt><dd>Area A = πr² · Circumference C = 2πr</dd>
  <dd>A circle has 360° of arc, or 2π radians</dd>
  <dt>Rectangle</dt><dd>A = ℓw</dd>
  <dt>Triangle</dt><dd>A = ½bh · angles sum to 180°</dd>
  <dt>Pythagorean theorem</dt><dd>a² + b² = c²</dd>
  <dt>Special right triangles</dt><dd>30°-60°-90°: x, x√3, 2x</dd><dd>45°-45°-90°: s, s, s√2</dd>
  <dt>Volume</dt><dd>Rectangular prism V = ℓwh</dd><dd>Cylinder V = πr²h</dd><dd>Sphere V = (4/3)πr³</dd><dd>Cone V = (1/3)πr²h</dd><dd>Pyramid V = (1/3)ℓwh</dd>
</dl></div>`;

// ---------- dashboard: today's plan, skills table, and an at-a-glance rail ----------

let skillTable = { filter: 'all', sort: 'mastery', dir: 1 };

function weakestSkills(n) {
  return exam.sections.flatMap(sec => skillAbilities(progress, sec.id, exam).filter(s => s.answered >= 2))
    .sort((a, b) => a.theta - b.theta).slice(0, n);
}

const studyDays = () => new Set(allResponses().map(r => dayKey(r.at)));

function bestStreak() {
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of [...studyDays()].sort()) {
    const time = new Date(`${day}T12:00`).getTime();
    run = previous != null && Math.round((time - previous) / DAY_MS) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = time;
  }
  return best;
}

function practiceSkill(section, skill) {
  session = { kind: 'practice', section, skill, done: 0, correct: 0, q: null };
  go(`practice/${section}`);
}

// Today's plan: due reviews, then the rest of the daily goal split across the two weakest skills, then a timed
// section if none has been taken in the last week.
function todaysPlan() {
  const today = dayKey(Date.now());
  const due = dueMistakes(progress.mistakes).filter(id => byId.has(id)).length;
  const reviewedToday = progress.responses.some(r => r.source === 'review' && dayKey(r.at) === today);
  const goal = progress.plan.dailyGoal;
  const left = Math.max(0, goal - answeredToday());
  const tasks = [];
  if (due || reviewedToday) {
    tasks.push({ label: due ? `Clear ${plural(due, 'review question')}` : 'Clear review questions', minutes: Math.ceil(due * 1.2), done: !due, run: () => go('review/go') });
  }
  const focus = weakestSkills(2);
  if (!left) {
    tasks.push({ label: `${goal} practice questions`, done: true });
  } else if (focus.length) {
    const first = focus.length > 1 ? Math.ceil(left / 2) : left;
    focus.forEach((skill, k) => {
      const count = k === 0 ? first : left - first;
      if (count > 0) tasks.push({ label: `${plural(count, 'question')} · ${skill.name}`, minutes: Math.ceil(count * 1.2), done: false, run: () => practiceSkill(skill.section, skill.name) });
    });
  } else {
    const section = exam.sections[0];
    tasks.push({ label: `${plural(left, 'practice question')} · ${section.name}`, minutes: Math.ceil(left * 1.2), done: false, run: () => go(`practice/${section.id}`) });
  }
  const lastTest = progress.tests[progress.tests.length - 1];
  if (pool.length && (!lastTest || Date.now() - lastTest.at > 7 * DAY_MS)) {
    const section = scoredSections(exam)[0];
    tasks.push({ label: `Timed ${section.name} section`, minutes: sectionMinutes([section]), done: false, run: () => go('test') });
  }
  return tasks;
}

function viewHome() {
  if (test?.finished) test = null;
  const days = daysUntilTest();
  const tasks = todaysPlan();
  const next = tasks.find(t => !t.done);
  const done = tasks.filter(t => t.done).length;
  const minutesLeft = tasks.filter(t => !t.done).reduce((sum, t) => sum + (t.minutes || 0), 0);
  const eyebrow = `${exam.long}${days == null ? '' : days >= 0 ? ` · ${plural(days, 'day')} to test day` : ' · test date passed'}`;
  view.innerHTML = `
    ${pageHead('Dashboard', { eyebrow })}
    <div class="ws-grid">
      <div class="ws-main">
        <section class="plan-card" aria-labelledby="plan-title">
          <div class="plan-top">
            <div>
              <p class="eyebrow">Today’s plan${minutesLeft ? ` · about ${minutesLeft} min left` : ''}</p>
              <h2 id="plan-title">${next ? `${done} of ${tasks.length} done. Next: ${esc(next.label)}` : 'Today’s plan is done. Nice work.'}</h2>
            </div>
            ${next ? `<button class="primary" data-task="${tasks.indexOf(next)}">${done ? 'Continue' : 'Start'}</button>` : '<a class="button" href="#/practice">Practice more</a>'}
          </div>
          <ul class="tasks">${tasks.map((t, k) => `<li class="${t.done ? 'done' : ''}">
            <span class="task-check" aria-hidden="true">${t.done ? '✓' : ''}</span>
            ${t.done || !t.run ? `<span class="task-label">${esc(t.label)}</span>` : `<button type="button" class="task-label link" data-task="${k}">${esc(t.label)}</button>`}
            <small>${t.done ? 'done' : t.minutes ? `${t.minutes} min` : ''}</small>
          </li>`).join('')}</ul>
        </section>
        ${skillsTableHtml()}
        <p class="hint">Mastery is your estimated chance of answering a Medium question in that skill correctly. Scores are estimates, not official ${exam.maker} scores. ${progress.profile.mode === 'grade' ? `Starting level: grade ${progress.profile.grade}` : 'Starting level: placement test'} · <a href="#/start">change</a></p>
      </div>
      <aside class="ws-rail" aria-label="At a glance">${railHtml(days)}</aside>
    </div>`;
  on('[data-task]', 'click', e => tasks[Number(e.currentTarget.dataset.task)]?.run?.());
  bindSkillsTable();
}

function skillRows() {
  return exam.sections.flatMap(sec => skillAbilities(progress, sec.id, exam)
    .filter(s => s.answered || pool.some(q => q.section === sec.id && q.skill === s.name))
    .map(s => ({
      ...s, sectionShort: sec.short,
      mastery: s.answered ? pCorrect(s.theta, DIFFICULTY_B.Medium) : null,
      accuracy: s.answered ? s.correct / s.answered : null,
    })));
}

function skillsTableHtml() {
  const { filter, sort, dir } = skillTable;
  const showSection = exam.sections.length > 1 && filter === 'all';
  const rows = skillRows().filter(r => filter === 'all' || r.section === filter);
  const value = r => (sort === 'skill' ? r.name : r[sort]);
  rows.sort((a, c) => {
    const x = value(a);
    const y = value(c);
    if (x == null && y == null) return a.name.localeCompare(c.name);
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
  const th = (key, label, cls = '') => `<th class="${cls}" aria-sort="${sort === key ? (dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="sort" data-sort="${key}">${label}<span aria-hidden="true">${sort === key ? (dir === 1 ? ' ↑' : ' ↓') : ''}</span></button></th>`;
  return `<section class="table-card" aria-labelledby="skills-title">
      <div class="table-card-head">
        <h2 id="skills-title">Skills</h2>
        <div class="chips" role="group" aria-label="Show section">${[['all', 'All'], ...exam.sections.map(s => [s.id, s.short])].map(([id, label]) => `<button type="button" class="chip${filter === id ? ' active' : ''}" data-filter="${id}" aria-pressed="${filter === id}">${esc(label)}</button>`).join('')}</div>
      </div>
      <div class="table-wrap"><table class="skills-table stack">
        <thead><tr>${th('skill', 'Skill')}${showSection ? '<th>Section</th>' : ''}${th('mastery', 'Mastery')}${th('accuracy', 'Accuracy', 'num')}${th('answered', 'Answered', 'num')}<th><span class="visually-hidden">Practice</span></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `<tr>
          <td>${esc(r.name)}</td>
          ${showSection ? `<td data-label="Section">${esc(r.sectionShort)}</td>` : ''}
          <td data-label="Mastery">${r.mastery == null ? '<span class="muted">not started</span>' : `<span class="mastery"><span class="track"><span class="fill ${masteryClass(r.mastery)}" style="width:${Math.round(r.mastery * 100)}%"></span></span><span class="pct">${Math.round(r.mastery * 100)}%</span></span>`}</td>
          <td class="num" data-label="Accuracy">${r.accuracy == null ? '—' : `${Math.round(r.accuracy * 100)}%`}</td>
          <td class="num" data-label="Answered">${r.answered}</td>
          <td class="num"><button type="button" class="small" data-skill="${esc(r.name)}" data-section="${r.section}" aria-label="Practice ${esc(r.name)}">Practice</button></td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted">No skills with questions yet.</td></tr>'}</tbody>
      </table></div>
    </section>`;
}

function bindSkillsTable() {
  on('.table-card [data-filter]', 'click', e => { skillTable = { ...skillTable, filter: e.currentTarget.dataset.filter }; redrawSkillsTable(); });
  on('.table-card [data-sort]', 'click', e => {
    const key = e.currentTarget.dataset.sort;
    const firstDir = key === 'answered' ? -1 : 1;
    skillTable = { ...skillTable, sort: key, dir: skillTable.sort === key ? -skillTable.dir : firstDir };
    redrawSkillsTable(key);
  });
  on('.table-card [data-skill]', 'click', e => practiceSkill(e.currentTarget.dataset.section, e.currentTarget.dataset.skill));
}

function redrawSkillsTable(focusSort) {
  const card = $('.table-card');
  if (!card) return;
  card.outerHTML = skillsTableHtml();
  bindSkillsTable();
  (focusSort ? $(`.table-card [data-sort="${focusSort}"]`) : $('.table-card [data-filter][aria-pressed="true"]'))?.focus();
}

function railHtml(days) {
  const streak = streakDays();
  const studied = studyDays();
  const week = Array.from({ length: 7 }, (_, k) => { const d = new Date(); d.setDate(d.getDate() - (6 - k)); return d; });
  const total = projectedTotal();
  const target = progress.plan.target;
  const queue = Object.entries(progress.mistakes).filter(([id, m]) => byId.has(id) && !m.graduated).sort((a, b) => a[1].due - b[1].due).slice(0, 3);
  const dueLabel = at => (at <= Date.now() ? 'now' : new Date(at).toLocaleDateString(undefined, { weekday: 'short' }));
  const testDay = progress.plan.testDate && new Date(`${progress.plan.testDate}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `
    <section class="rail-card">
      <h2 class="rail-label">Streak</h2>
      <p class="rail-big">${plural(streak, 'day')}<small>best ${plural(Math.max(streak, bestStreak()), 'day')}</small></p>
      <ol class="week" aria-label="Days studied this week">${week.map(d => {
        const on = studied.has(dayKey(d));
        return `<li class="${on ? 'on' : ''}"><i></i><span aria-hidden="true">${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span><span class="visually-hidden">${d.toLocaleDateString(undefined, { weekday: 'long' })}: ${on ? 'studied' : 'no study'}</span></li>`;
      }).join('')}</ol>
    </section>
    <section class="rail-card">
      <h2 class="rail-label">${totalLabel()}</h2>
      ${total ? `<p class="rail-big">${total.mid}<small>likely ${range(total)}</small></p>
        <p class="hint">${target ? (total.mid >= target ? `At or above your ${target} target` : `${plural(target - total.mid, 'point')} to your ${target} target`) : '<a href="#/plan">Set a target</a>'}</p>`
        : '<p class="hint">Answer a few questions in every section to see an estimate.</p>'}
      <a class="rail-link" href="#/scores">See scores</a>
    </section>
    <section class="rail-card">
      <h2 class="rail-label">Review queue</h2>
      ${queue.length ? `<ul class="queue">${queue.map(([id, m]) => `<li><span>${esc(byId.get(id).skill)}</span><span>${dueLabel(m.due)}</span></li>`).join('')}</ul>`
        : '<p class="hint">Nothing to review. Questions you miss land here.</p>'}
    </section>
    <section class="rail-card">
      <h2 class="rail-label">Test day</h2>
      ${testDay ? `<p class="rail-big">${testDay}<small>${days >= 0 ? plural(days, 'day') + ' away' : 'date passed'}</small></p>` : '<p class="hint"><a href="#/plan">Set your test date</a></p>'}
    </section>`;
}

// ---------- scores: the score report ----------

function viewScores() {
  const total = projectedTotal();
  const target = progress.plan.target;
  const history = progress.tests.filter(t => t.total);
  const weekAgo = Date.now() - 7 * DAY_MS;
  const thisWeek = progress.responses.filter(r => r.at > weekAgo).length;
  const lastWeek = progress.responses.filter(r => r.at <= weekAgo && r.at > weekAgo - 7 * DAY_MS).length;
  const recent = progress.responses.slice(-100);
  const accuracy = recent.length ? Math.round((recent.filter(r => r.correct).length / recent.length) * 100) : null;
  const due = dueMistakes(progress.mistakes).filter(id => byId.has(id)).length;
  const streak = streakDays();
  view.innerHTML = `
    ${pageHead('Scores', { eyebrow: exam.long, actions: '<a class="button" href="#/test">Take a timed test</a>' })}
    <section class="score-hero">
      <div>
        <p class="eyebrow">${totalLabel()}</p>
        ${total ? `<p class="hero-score">${total.mid}</p>
          <p class="muted">likely ${range(total)}${target ? ` · ${total.mid >= target ? 'at or above your target' : `${plural(target - total.mid, 'point')} to your ${target} target`}` : ''}</p>
          ${scaleHtml(total, target)}`
          : `<p class="hero-empty">Not enough answers yet</p><p class="muted">Answer at least five questions in each of ${scoredSections(exam).map(s => s.name).join(', ')}, or take the placement test, to see an estimate.</p>`}
      </div>
      ${trendHtml(history, target)}
    </section>
    <div class="kpis">
      <div class="kpi"><span class="eyebrow">Streak</span><strong>${plural(streak, 'day')}</strong><span class="muted">best ${plural(Math.max(streak, bestStreak()), 'day')}</span></div>
      <div class="kpi"><span class="eyebrow">This week</span><strong>${thisWeek}</strong><span class="muted">${thisWeek === 1 ? 'question' : 'questions'}${thisWeek || lastWeek ? ` · ${thisWeek >= lastWeek ? '▲' : '▼'} ${Math.abs(thisWeek - lastWeek)} vs last week` : ''}</span></div>
      <div class="kpi"><span class="eyebrow">Accuracy</span><strong>${accuracy == null ? '—' : `${accuracy}%`}</strong><span class="muted">${recent.length ? `last ${plural(recent.length, 'answer')}` : 'no answers yet'}</span></div>
      <div class="kpi"><span class="eyebrow">Review due</span><strong>${due}</strong><span class="muted">${due ? `about ${Math.ceil(due * 1.2)} min` : 'all caught up'}</span></div>
    </div>
    <div class="section-scores">${exam.sections.map(s => {
      const estimate = sectionEstimate(s.id);
      return `<div class="kpi"><span class="eyebrow">${s.name}${s.optional ? ' · optional' : ''}</span>${estimate ? `<strong>${estimate.mid}</strong><span class="muted">likely ${range(estimate)}</span>` : '<span class="muted">Not enough answers yet</span>'}</div>`;
    }).join('')}</div>
    <div class="skill-lists">${exam.sections.map(sec => {
      const skills = skillAbilities(progress, sec.id, exam).filter(s => s.answered)
        .map(s => ({ ...s, p: pCorrect(s.theta, DIFFICULTY_B.Medium) })).sort((a, b) => a.p - b.p);
      return `<section class="card">
        <header class="card-head"><h2>${sec.name}</h2><span class="muted">weakest first</span></header>
        ${skills.length ? `<ul class="skill-list">${skills.map(s => `<li><span>${esc(s.name)}</span><span class="mastery-chip ${masteryClass(s.p)}"><i aria-hidden="true"></i>${masteryName(s.p)} · ${Math.round(s.p * 100)}%</span><button type="button" class="small ghost" data-skill="${esc(s.name)}" data-section="${sec.id}" aria-label="Practice ${esc(s.name)}">Practice</button></li>`).join('')}</ul>`
          : '<p class="muted">No answers in this section yet.</p>'}
      </section>`;
    }).join('')}</div>
    <p class="hint">Estimates come from your answers and each question's difficulty. They aren't official ${exam.maker} scores.</p>`;
  on('[data-skill]', 'click', e => practiceSkill(e.currentTarget.dataset.section, e.currentTarget.dataset.skill));
  bindTrend(history);
}

// The estimate and likely range on the test's real scale, with the target marked.
function scaleHtml(estimate, target) {
  const { min, max } = exam.total;
  const at = v => `${((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100}%`;
  const ticks = exam.total.kind === 'sum' ? [0, 1, 2, 3].map(k => min + (k * (max - min)) / 3) : [min, 12, 24, max];
  return `<div class="scale" role="img" aria-label="Estimate ${estimate.mid}, likely ${range(estimate)}, on a scale of ${min} to ${max}${target ? `, target ${target}` : ''}">
      <div class="scale-track"><span class="scale-band" style="left:${at(estimate.low)};width:calc(${at(estimate.high)} - ${at(estimate.low)})"></span>${target ? `<span class="scale-target" style="left:${at(target)}"></span>` : ''}<span class="scale-dot" style="left:${at(estimate.mid)}"></span></div>
      <div class="scale-ticks" aria-hidden="true">${ticks.map(t => `<span style="left:${at(t)}">${Math.round(t)}</span>`).join('')}</div>
      <div class="scale-legend" aria-hidden="true"><span><i class="key-dot"></i>Estimate</span><span><i class="key-band"></i>Likely range</span>${target ? `<span><i class="key-target"></i>Target ${target}</span>` : ''}</div>
    </div>`;
}

// Totals from the last ten full timed tests: one series on one scale, hover for each test, and a table view.
function trendHtml(history, target) {
  const title = exam.total.kind === 'average' ? `Practice test ${exam.total.label}s` : 'Practice test totals';
  if (history.length < 2) {
    return `<div class="chart chart-empty"><h3>${title}</h3><p class="muted">${history.length ? 'Take one more full timed test' : 'Take two full timed tests'} to see your trend here.</p><a class="button small" href="#/test">Take a timed test</a></div>`;
  }
  const points = history.slice(-10);
  const values = points.map(t => t.total.mid);
  const sum = exam.total.kind === 'sum';
  let step = sum ? 100 : 2;
  const low = Math.min(...values, target ?? Infinity);
  const high = Math.max(...values, target ?? -Infinity);
  if ((high - low) / step > 5) step *= 2;
  const yMin = Math.max(exam.total.min - (exam.total.min % step), Math.floor((low - step / 2) / step) * step);
  const yMax = Math.min(exam.total.max + ((step - (exam.total.max % step)) % step), Math.ceil((high + step / 2) / step) * step);
  const W = 560; const H = 220; const L = 48; const R = 52; const T = 18; const B = 34;
  const x = i => L + (i * (W - L - R)) / (points.length - 1);
  const y = v => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const ticks = [];
  for (let v = yMin; v <= yMax; v += step) ticks.push(v);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const date = t => new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const every = points.length > 6 ? 2 : 1;
  const last = points.length - 1;
  return `<div class="chart" id="trend">
      <h3>${title}</h3><p class="muted">Last ${plural(points.length, 'full timed test')}</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}: ${points.map((t, i) => `${date(t)} ${values[i]}`).join(', ')}">
        <g class="chart-grid">${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')}</g>
        <g class="chart-axis">${ticks.map(v => `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('')}
          ${points.map((t, i) => ((last - i) % every === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${date(t)}</text>` : '')).join('')}</g>
        ${target && target >= yMin && target <= yMax ? `<line class="chart-target" x1="${L}" x2="${W - R}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/><text class="chart-note" x="${W - R}" y="${(y(target) - 6).toFixed(1)}" text-anchor="end">Target ${target}</text>` : ''}
        <path class="chart-area" d="${line} L${x(last).toFixed(1)} ${H - B} L${L} ${H - B} Z"/>
        <path class="chart-line" d="${line}"/>
        <line class="chart-cross" id="trend-cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
        ${values.map((v, i) => `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5"/>`).join('')}
        <text class="chart-end" x="${(x(last) + 10).toFixed(1)}" y="${(y(values[last]) + 4).toFixed(1)}">${values[last]}</text>
        <rect id="trend-hit" x="${L - 10}" y="${T}" width="${W - L - R + 20}" height="${H - T - B}" fill="transparent"/>
      </svg>
      <div class="chart-tip" id="trend-tip" hidden></div>
      <details class="chart-table"><summary>View as table</summary>
        <table><thead><tr><th>Test date</th><th>${exam.total.label ?? 'Total'}</th><th>Likely range</th></tr></thead>
        <tbody>${points.map(t => `<tr><td>${date(t)}</td><td class="num">${t.total.mid}</td><td class="num">${range(t.total)}</td></tr>`).join('')}</tbody></table>
      </details>
    </div>`;
}

function bindTrend(history) {
  const box = $('#trend');
  const hit = $('#trend-hit');
  if (!box || !hit) return;
  const svg = box.querySelector('svg');
  const cross = $('#trend-cross');
  const tip = $('#trend-tip');
  const points = history.slice(-10);
  const dots = [...svg.querySelectorAll('.chart-dot')];
  const show = evt => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / svg.viewBox.baseVal.width;
    const px = (evt.clientX - rect.left) / scale;
    let i = 0;
    dots.forEach((d, k) => { if (Math.abs(d.cx.baseVal.value - px) < Math.abs(dots[i].cx.baseVal.value - px)) i = k; });
    const cx = dots[i].cx.baseVal.value;
    const cy = dots[i].cy.baseVal.value;
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    const boxRect = box.getBoundingClientRect();
    tip.hidden = false;
    tip.textContent = `${new Date(points[i].at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${points[i].total.mid} (likely ${range(points[i].total)})`;
    tip.style.left = `${rect.left - boxRect.left + cx * scale}px`;
    tip.style.top = `${rect.top - boxRect.top + cy * scale}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

// ---------- study plan ----------

function suggestedDailyGoal(days, gap) {
  // Measure the gap against the size of the test's scale, so an ACT point counts like a proportional SAT gap.
  const span = exam.total.max - exam.total.min;
  const scaledGap = gap == null ? null : (gap / span) * 1200;
  let goal = 20;
  if (scaledGap > 0) goal += scaledGap / 5;
  if (days != null && days <= 14 && scaledGap > 0) goal += 10;
  return Math.max(15, Math.min(60, Math.round(goal / 5) * 5));
}

function testCadence(days) {
  if (days == null) return 'Take a timed practice test every one to two weeks.';
  if (days < 0) return 'Your test date has passed. Set a new one to get a schedule.';
  if (days > 56) return 'Take a full timed practice test every two weeks.';
  if (days > 14) return 'Take a full timed practice test once a week.';
  return 'Take a full timed test now and another 3–4 days before test day, then keep the last two days light.';
}

function viewPlan() {
  const plan = progress.plan;
  const days = daysUntilTest();
  const total = projectedTotal();
  const gap = plan.target && total ? plan.target - total.mid : null;
  const suggestion = suggestedDailyGoal(days, gap);
  const weakest = weakestSkills(5);
  const estimates = scoredSections(exam).map(s => [s, sectionEstimate(s.id)]).filter(([, e]) => e);
  const weakerSection = estimates.length === scoredSections(exam).length && estimates.length > 1
    ? estimates.sort((a, b) => a[1].mid - b[1].mid)[0][0] : null;
  const step = exam.total.kind === 'sum' ? 10 : 1;

  view.innerHTML = `
    ${pageHead('Study plan', { eyebrow: exam.long })}
    <div class="cards">
      <form class="card" id="plan-form">
        <h2>Your goal</h2>
        <label class="field">Test date <input type="date" name="testDate" value="${esc(plan.testDate || '')}"></label>
        <label class="field">Target ${totalLabel().toLowerCase().replace('estimated ', '')} score <input type="number" name="target" min="${exam.total.min}" max="${exam.total.max}" step="${step}" value="${plan.target || ''}" placeholder="${exam.total.min}–${exam.total.max}"></label>
        <label class="field">Daily question goal <input type="number" name="dailyGoal" min="5" max="150" value="${plan.dailyGoal}"></label>
        <button class="primary">Save</button>
      </form>
      <div class="card">
        <h2>Where you stand</h2>
        <p>${days == null ? 'No test date set.' : days >= 0 ? `<strong>${plural(days, 'day')}</strong> until test day.` : 'Your test date has passed.'}</p>
        <p>${total ? `${totalLabel()} <strong>${total.mid}</strong> (likely ${range(total)}).` : `Practice every section to get an ${totalLabel().toLowerCase()}.`}</p>
        ${gap != null ? `<p>${gap > 0 ? `About <strong>${plural(gap, 'point')}</strong> to your target.` : 'Your estimate is at or above your target. Keep it steady.'}</p>` : ''}
      </div>
    </div>
    <div class="card">
      <h2>Suggested routine</h2>
      <ul>
        <li>Answer <strong>${suggestion} practice questions</strong> a day${weakerSection ? `, leaning toward ${weakerSection.name}` : ''}.${suggestion !== plan.dailyGoal ? ` <button class="small" id="use-suggestion">Use ${suggestion} as my goal</button>` : ''}</li>
        <li>Clear your due Review questions every day before new practice.</li>
        <li>${testCadence(days)}</li>
      </ul>
      <p class="hint">These suggestions are rules of thumb based on your goal and current estimate.</p>
    </div>
    <div class="card">
      <h2>Focus skills</h2>
      ${weakest.length ? weakest.map(s => `<div class="skill-row"><span class="name">${esc(s.name)} <span class="muted">· ${sectionShort(s.section)}</span></span>
        <div class="track"><div class="fill ${masteryClass(pCorrect(s.theta, 0))}" style="width:${Math.round(pCorrect(s.theta, 0) * 100)}%"></div></div>
        <button class="small" data-focus="${esc(s.name)}" data-section="${s.section}">Practice</button></div>`).join('')
        : '<p class="muted">Answer at least two questions in a skill to see where to focus.</p>'}
    </div>`;

  on('#plan-form', 'submit', e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const target = Number(f.get('target')) || null;
    progress.plan = {
      testDate: f.get('testDate') || null,
      target: target && Math.min(exam.total.max, Math.max(exam.total.min, target)),
      dailyGoal: Math.max(5, Number(f.get('dailyGoal')) || 20),
    };
    touch('plan');
    save();
    toast('Saved');
    viewPlan();
  });
  on('#use-suggestion', 'click', () => { progress.plan.dailyGoal = suggestion; touch('plan'); save(); toast('Saved'); viewPlan(); });
  on('[data-focus]', 'click', e => {
    const { focus, section } = e.currentTarget.dataset;
    session = { kind: 'practice', section, skill: focus, done: 0, correct: 0, q: null };
    go(`practice/${section}`);
  });
}

// ---------- library & settings ----------

function viewLibrary() {
  const rows = exam.domains.map(d => {
    const qs = pool.filter(q => q.domain === d.name);
    const n = level => qs.filter(q => q.difficulty === level).length;
    return `<tr><td>${sectionShort(d.section)}</td><td>${esc(d.name)}</td><td class="num">${n('Easy')}</td><td class="num">${n('Medium')}</td><td class="num">${n('Hard')}</td><td class="num"><strong>${qs.length}</strong></td></tr>`;
  }).join('');
  const source = !pool.length
    ? (exam.source === 'act'
      ? '<p class="note"><strong>ACT support is still being built.</strong> The ACT sections, skills, scoring and timed-test format are ready, but reading ACT’s official practice test PDFs isn’t finished, so there are no ACT questions yet. Until then, the <a href="#/resources">official ACT practice tests</a> are available on act.org.</p>'
      : `<p class="note">There are no ${exam.long} questions yet. To add them, ${addQuestionsHint()}.</p>`)
    : library.borrowed
      ? `<p class="note">No ${exam.long} questions have been added yet, so ${exam.name} practice uses the ${plural(pool.length, `${library.source === 'demo' ? 'demo' : 'SAT'} question`)}, which cover the same skills. To add ${exam.name} questions, ${addQuestionsHint()}.</p>`
      : library.source === 'demo'
        ? `<p class="note">No official questions are built in yet, so ${plural(pool.length, 'demo question')} are in use. To add real ones, ${addQuestionsHint()}.</p>`
        : `<p class="muted">${plural(pool.length, `${exam.name} question`)}. To add more, ${addQuestionsHint()}.</p>`;

  view.innerHTML = `
    ${pageHead('Question library', { eyebrow: exam.long })}
    ${source}
    ${library.warnings.length ? `<div class="card"><h2>Skipped questions</h2>${library.warnings.map(w => `<p class="warn">${esc(w)}</p>`).join('')}</div>` : ''}
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Section</th><th>Domain</th><th class="num">Easy</th><th class="num">Medium</th><th class="num">Hard</th><th class="num">Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Settings</h2>
      <p class="hint">Resetting erases your ${exam.name} practice history, mistake log, test results and study plan${syncConfigured ? ' on every device signed in to your account' : ''}. Your other tests aren't affected.</p>
      <div class="actions"><button class="danger" id="reset">Reset ${exam.name} progress</button></div>
    </div>`;

  confirmButton('#reset', 'Click again to erase progress', () => {
    // The reset time travels with synced progress, so every signed-in device drops what came before it.
    const now = Date.now();
    replaceProgress(examId, { ...store.defaultProgress(), resetAt: now, stamps: { profile: now, placement: now, plan: now } }, { push: true });
    session = null;
    if (test?.exam === examId) test = null;
    toast(`${exam.name} progress reset`);
    go('start');
  });
}

// ---------- resources ----------

const link = (title, url, about) => ({ title, url, about });
const BIGFUTURE = link('BigFuture', 'https://bigfuture.collegeboard.org/', "College Board's free site for exploring colleges, careers and scholarships.");

const RESOURCES = {
  sat: [
    { title: 'Official practice', links: [
      link('Bluebook', 'https://bluebook.collegeboard.org/', "College Board's testing app, where the digital SAT is taken. Its full-length practice tests use the same timing, tools and adaptive modules as test day."),
      link('Download Bluebook', 'https://bluebook.collegeboard.org/students/download-bluebook', 'Install the app on a Mac, Windows PC, iPad or Chromebook.'),
      link('Official SAT practice tests', 'https://satsuite.collegeboard.org/practice/practice-tests', 'Free full-length practice tests, in Bluebook or as PDFs with answer explanations.'),
      link('My Practice', 'https://mypractice.collegeboard.org/', 'Scores, answer explanations and skill breakdowns for the practice tests you take in Bluebook.'),
      link('SAT Suite Question Bank', 'https://satsuiteeducatorquestionbank.collegeboard.org/', "College Board's official question bank. Its PDF exports are what this app's SAT and PSAT library is built from."),
    ] },
    { title: 'Learn and practice', links: [
      link('SAT practice and preparation', 'https://satsuite.collegeboard.org/practice', "College Board's hub for free prep materials, including the official study guide."),
      link('Khan Academy: Digital SAT', 'https://www.khanacademy.org/test-prep/digital-sat', 'Free lessons and practice for each skill on the test.'),
      link('Desmos test calculator', 'https://www.desmos.com/testing/collegeboard/graphing', 'The version of the Desmos graphing calculator used on the digital SAT Suite, to get comfortable with before test day.'),
    ] },
    { title: 'About the test', links: [
      link("What's on the SAT", 'https://satsuite.collegeboard.org/sat/whats-on-the-test', 'How the test is structured and the skills each section covers.'),
      link('Register for the SAT', 'https://satsuite.collegeboard.org/sat/registration', 'Sign up for a test date and find a test center.'),
      link('Test dates and deadlines', 'https://satsuite.collegeboard.org/sat/dates-deadlines', 'Upcoming test dates, registration deadlines and score release dates.'),
      link('SAT scores', 'https://satsuite.collegeboard.org/scores', 'Getting your scores and understanding what they mean.'),
    ] },
    { title: 'Planning for college', links: [BIGFUTURE] },
  ],
  psat: [
    { title: 'Official practice', links: [
      link('SAT Suite Question Bank', 'https://satsuiteeducatorquestionbank.collegeboard.org/', 'Filter by PSAT/NMSQT and PSAT 10 to export official questions for this app.'),
      link('SAT Suite practice and preparation', 'https://satsuite.collegeboard.org/practice', "College Board's free prep materials for the whole SAT Suite, including the PSATs."),
      link('Desmos test calculator', 'https://www.desmos.com/testing/collegeboard/graphing', 'The Desmos graphing calculator used on the digital SAT Suite.'),
    ] },
    { title: 'About the test', links: [
      link("What's on the PSAT/NMSQT", 'https://satsuite.collegeboard.org/in-school-assessments/whats-on-the-test/psat-nmsqt', 'How the test is structured and the skills it covers.'),
      link('SAT Suite scores', 'https://satsuite.collegeboard.org/scores', 'Getting your scores and understanding what they mean.'),
    ] },
    { title: 'Learn and plan', links: [
      link('Khan Academy: Digital SAT', 'https://www.khanacademy.org/test-prep/digital-sat', 'Free lessons for the same skills the PSAT tests.'),
      BIGFUTURE,
    ] },
  ],
  psat89: [
    { title: 'Official practice', links: [
      link('SAT Suite Question Bank', 'https://satsuiteeducatorquestionbank.collegeboard.org/', 'Filter by PSAT 8/9 to export official questions for this app.'),
      link('SAT Suite practice and preparation', 'https://satsuite.collegeboard.org/practice', "College Board's free prep materials for the whole SAT Suite, including the PSATs."),
    ] },
    { title: 'About the test', links: [
      link("What's on the PSAT 8/9", 'https://satsuite.collegeboard.org/in-school-assessments/whats-on-the-test/psat-8-9', 'How the test is structured and the skills it covers.'),
      link('SAT Suite scores', 'https://satsuite.collegeboard.org/scores', 'Getting your scores and understanding what they mean.'),
    ] },
    { title: 'Learn and plan', links: [
      link('Khan Academy: Digital SAT', 'https://www.khanacademy.org/test-prep/digital-sat', 'Free lessons for the same skills the PSAT 8/9 tests.'),
      BIGFUTURE,
    ] },
  ],
  act: [
    { title: 'Official practice', links: [
      link('ACT test prep', 'https://www.act.org/content/act/en/products-and-services/the-act/test-preparation.html', "ACT's free official prep page, with full-length practice tests."),
      link('ACT Practice Test 2 (PDF)', 'https://www.act.org/content/dam/act/unsecured/documents/ACT-Test-Prep-ACT-Practice-Test-2-Form.pdf', 'A complete official practice test with an answer key. Practicing with it inside this app is still being built.'),
      link('Preparing for the ACT (PDF)', 'https://www.act.org/content/dam/act/unsecured/documents/Preparing-for-the-ACT.pdf', 'The official guide booklet, with a full practice test, answer key and scoring tables.'),
      link('The Official ACT Prep Guide', 'https://www.act.org/content/act/en/products-and-services/the-act/test-preparation/the-official-guide.html', "ACT's official study guide book (paid), with more practice tests."),
    ] },
    { title: 'About the test', links: [
      link('Register for the ACT', 'https://www.act.org/content/act/en/products-and-services/the-act/registration.html', 'Sign up for a test date and find a test center or online option.'),
      link('ACT scores', 'https://www.act.org/content/act/en/products-and-services/the-act/scores.html', 'Getting your scores and understanding the Composite.'),
    ] },
    { title: 'Learn and plan', links: [
      link('Khan Academy: ACT', 'https://www.khanacademy.org/test-prep/act', 'Free lessons and practice for ACT math and reading skills.'),
      BIGFUTURE,
    ] },
  ],
};

function viewResources() {
  view.innerHTML = `
    ${pageHead('Resources', { eyebrow: exam.long })}
    <p class="muted">Official ${exam.maker} tools and other free places to prepare for the ${exam.long}. Links open in a new tab.</p>
    <div class="cards">${RESOURCES[examId].map(group => `
      <section class="card">
        <h2>${esc(group.title)}</h2>
        <ul class="links">${group.links.map(({ title, url, about }) => {
          // The last word and the arrow wrap together, so the arrow never sits alone on a line.
          const cut = title.lastIndexOf(' ') + 1;
          return `
          <li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(title.slice(0, cut))}<span class="nowrap">${esc(title.slice(cut))}&nbsp;<span aria-hidden="true">↗</span></span></a><span class="hint">${esc(about)}</span></li>`;
        }).join('')}
        </ul>
      </section>`).join('')}
    </div>`;
}

// ---------- account & sync ----------

function viewAccount() {
  if (!syncConfigured) {
    view.innerHTML = `${pageHead('Account')}<p class="note">Cloud sync isn't set up for this copy of ${APP_NAME}, so progress stays on this device.</p>`;
    return;
  }
  const sync = syncState();
  if (sync.phase === 'loading') {
    view.innerHTML = `${pageHead('Account')}<p class="muted">Connecting…</p>`;
    return;
  }
  if (sync.account) {
    const time = sync.lastSynced && new Date(sync.lastSynced).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const status = sync.phase === 'error' ? sync.message : sync.phase === 'synced' ? `Up to date${time ? ` · last synced ${time}` : ''}.` : 'Syncing…';
    view.innerHTML = `
      ${pageHead('Account')}
      <div class="card">
        <p>Signed in as <strong>${esc(sync.account)}</strong>.</p>
        <p class="${sync.phase === 'error' ? 'warn' : 'muted'}">${esc(status)}</p>
        <p class="hint">Progress for every test (${EXAM_IDS.map(id => EXAMS[id].name).join(', ')}) syncs automatically to every device where you sign in. Your changes upload within a few seconds, and changes from your other devices show up on their own.</p>
        <div class="actions">
          ${progress.profile.mode ? '' : '<a class="button primary" href="#/start">Continue</a>'}
          <button id="sign-out">Sign out</button>
          <button class="danger" id="sign-out-clear">Sign out and clear this device</button>
        </div>
        <p class="hint">Signing out keeps a copy of your progress on this device. On a shared computer, use “Sign out and clear this device.”</p>
      </div>`;
    on('#sign-out', 'click', () => signOutOfSync());
    confirmButton('#sign-out-clear', 'Click again to sign out and clear', async () => {
      await signOutOfSync();
      EXAM_IDS.forEach(id => replaceProgress(id, store.defaultProgress()));
      session = null;
      test = null;
      go('start');
    });
    return;
  }

  view.innerHTML = `
    ${pageHead('Sign in to sync')}
    <p class="muted">Keep your progress on every device you study on. Progress already on this device is added to your account.</p>
    <div class="cards">
      <div class="card">
        <h2>Google</h2>
        <p>Sign in with your Google account.</p>
        <button class="primary" id="google">Sign in with Google</button>
      </div>
      <form class="card" id="username-form">
        <h2>Username and passcode</h2>
        <label class="field">Username <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label class="field">Passcode <input name="passcode" type="password" autocomplete="current-password" required></label>
        <div class="actions"><button class="primary" data-mode="sign-in">Sign in</button><button data-mode="create">Create account</button></div>
        <p class="hint">A forgotten passcode can't be recovered, so keep it somewhere safe.</p>
      </form>
    </div>
    <p class="warn" id="auth-error" role="alert">${esc(sync.phase === 'error' ? sync.message : '')}</p>`;

  const buttons = () => view.querySelectorAll('.card button');
  const attempt = async action => {
    buttons().forEach(b => { b.disabled = true; });
    $('#auth-error').textContent = '';
    try {
      await action(); // on success the sign-in listener re-renders this page
    } catch (err) {
      if (!view.contains($('#auth-error'))) return;
      $('#auth-error').textContent = err.message;
      buttons().forEach(b => { b.disabled = false; });
    }
  };
  on('#google', 'click', () => attempt(signInWithGoogle));
  on('#username-form', 'submit', e => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const create = e.submitter?.dataset.mode === 'create';
    attempt(() => signInWithUsername(form.get('username'), form.get('passcode'), { create }));
  });
}

// ---------- boot ----------

// The server builds data/questions.json from exports/ at startup; without it the demo questions are used.
async function loadLibrary() {
  try {
    const res = await fetch('data/questions.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.questions.length) return { source: 'exports', questions: data.questions, files: data.files, warnings: data.warnings };
    }
  } catch {
    // No built library yet.
  }
  return { source: 'demo', questions: DEMO_QUESTIONS, files: 0, warnings: [] };
}

// Earlier versions imported questions into IndexedDB in the browser; that copy is no longer used.
try { indexedDB.deleteDatabase('sat-prep'); } catch { /* storage unavailable */ }

window.addEventListener('hashchange', render);
loadLibrary().then(result => {
  library = { ...library, source: result.source, files: result.files, warnings: result.warnings || [] };
  allQuestions = result.questions;
  choosePool();
  render();
  let lastPhase = null;
  initSync({
    exams: EXAM_IDS,
    getProgress: id => progressByExam[id],
    setProgress: (id, next) => {
      if (JSON.stringify(next) === JSON.stringify(progressByExam[id])) return;
      const hadProfile = Boolean(progressByExam[id].profile.mode);
      replaceProgress(id, next);
      if (id !== examId) return renderNav(currentRoute);
      if (!hadProfile && progress.profile.mode && currentRoute === 'start') return go('home');
      // Refresh pages that only show progress; never re-render mid-question, mid-test or mid-form.
      if (!session && ['home', 'scores', 'review', 'account'].includes(currentRoute)) render();
      else renderNav(currentRoute);
    },
    onChange: state => {
      if (state.account && state.phase === 'synced' && lastPhase === 'syncing' && !state.lastSyncedToastShown) toast('Synced');
      lastPhase = state.account ? (lastPhase === 'synced' ? 'synced' : state.phase) : null;
      renderNav(currentRoute);
      if (currentRoute === 'account') viewAccount();
    },
  });
});
