import * as store from './store.js';
import { GRADES, SECTIONS, skillsForSection, DOMAINS } from './taxonomy.js';
import { DIFFICULTY_B, estimateAbility, pCorrect, projectSectionScore } from './irt.js';
import {
  buildModule, isCorrect, nextPlacementQuestion, nextPracticeQuestion, PLACEMENT, routeFor,
  sectionAbility, skillAbilities, TEST_FORMAT,
} from './adaptive.js';
import { addMistake, dueMistakes, reviewMistake } from './srs.js';
import { DEMO_QUESTIONS } from './demo-questions.js';
import { getDesmosKey, mountCalculator, setDesmosKey } from './calc.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const DAY_MS = 24 * 60 * 60 * 1000;
const MISTAKE_REASONS = ['Careless slip', "Didn't know the concept", 'Misread the question', 'Ran out of time', 'Guessed'];

let progress = store.loadProgress();
let pool = [];
let byId = new Map();
let library = { source: 'demo', files: 0, warnings: [] };
let session = null;   // the active placement, practice or review session
let test = null;      // the timed practice test, kept separately so browsing other pages doesn't end it
let currentRoute = null;
let ticker = null;

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const para = t => esc(t).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const inline = t => esc(t).replace(/\n/g, '<br>');
const $ = sel => view.querySelector(sel);
const on = (sel, event, fn) => view.querySelectorAll(sel).forEach(el => el.addEventListener(event, fn));
const save = () => store.saveProgress(progress);
const dayKey = t => new Date(t).toLocaleDateString('en-CA');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function go(path) {
  if (location.hash === `#/${path}`) render();
  else location.hash = `#/${path}`;
}

function sectionCount(section) {
  return pool.filter(q => q.section === section).length;
}

function answeredToday() {
  const today = dayKey(Date.now());
  return progress.responses.filter(r => dayKey(r.at) === today).length;
}

function streakDays() {
  const days = new Set(progress.responses.map(r => dayKey(r.at)));
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
  if (!progress.placement[section] && answered < 5) return null;
  return projectSectionScore(sectionAbility(progress, section));
}

function projectedTotal() {
  const rw = sectionEstimate('RW'), math = sectionEstimate('MATH');
  if (!rw || !math) return null;
  return { low: rw.low + math.low, mid: rw.mid + math.mid, high: rw.high + math.high };
}

function masteryClass(p) {
  return p < 0.45 ? 'low' : p < 0.7 ? 'mid' : 'high';
}

function clock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function snippet(q) {
  const text = [q.passage, q.stem].filter(Boolean).join(' ');
  if (!text) return `Question ${q.cbId ?? q.id}`;
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

// Questions built from exports keep math, graphs and tables as images (see scripts/build-questions.js).
function imgHtml(image, alt) {
  if (!image?.src) return '';
  return `<img class="qimg" src="${esc(image.src)}" alt="${esc(alt)}" width="${image.width}" height="${image.height}" loading="lazy">`;
}

// A typed-in answer drawn as math in the export can't be checked automatically; the student compares
// their answer with the image and marks it. Placement and timed tests only use gradable questions.
const gradable = q => q.answer != null;

function answerText(q) {
  return Array.isArray(q.answer) ? q.answer.join(' or ') : q.answer;
}

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

// ---------- routing ----------

const ROUTES = {
  home: viewHome, start: viewStart, placement: viewPlacement, placed: viewPlaced, practice: viewPractice,
  test: viewTest, review: viewReview, plan: viewPlan, library: viewLibrary,
};

function render() {
  clearInterval(ticker);
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const route = ROUTES[name] ? name : 'home';
  // Leaving a running test keeps its clock going; bank the time spent and highlights on the open question.
  if (currentRoute === 'test' && route !== 'test' && test && !test.finished && !test.onBreak) leaveQuestion();
  currentRoute = route;
  if (!pool.length && route !== 'library') return go('library');
  if (!progress.profile.mode && !['library', 'start', 'placement', 'placed'].includes(route)) return go('start');
  if (session && !sessionBelongsTo(route)) session = null;
  renderNav(route);
  window.scrollTo(0, 0);
  ROUTES[route](arg);
}

function sessionBelongsTo(route) {
  return { placement: 'placement', practice: 'practice', review: 'review' }[route] === session.kind;
}

function renderNav(active) {
  const due = dueMistakes(progress.mistakes).filter(id => byId.has(id)).length;
  const testRunning = test && !test.finished;
  const links = [
    ['home', 'Dashboard'], ['practice', 'Practice'], ['test', testRunning ? 'Practice test ●' : 'Practice test'],
    ['review', `Review${due ? ` <span class="badge">${due}</span>` : ''}`], ['plan', 'Study plan'], ['library', 'Library'],
  ];
  nav.innerHTML = links.map(([r, label]) => `<a href="#/${r}" class="${r === active ? 'active' : ''}">${label}</a>`).join('');
}

// ---------- shared question rendering ----------

function questionHtml(q, st = {}) {
  let prompt;
  if (q.promptImage) {
    prompt = `<div class="prompt-image">${imgHtml(q.promptImage, 'The question, as shown in the College Board export')}</div>`;
  } else {
    const passage = q.passage || st.passageHtml
      ? `<div class="passage">${st.passageHtml ?? para(q.passage)}</div>` : '';
    const figures = (q.figures || []).map(src => `<img class="figure" src="${esc(src)}" alt="Figure for this question">`).join('');
    prompt = `${passage}${figures}<div class="stem">${para(q.stem)}</div>`;
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
      return `<li class="${cls}" data-letter="${c.letter}">
        <button class="choice-btn" data-choice="${c.letter}" ${st.revealed ? 'disabled' : ''}><span class="letter">${c.letter}</span>${c.image ? imgHtml(c.image, `Choice ${c.letter}`) : `<span>${inline(c.text)}</span>`}</button>
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
      : `<div class="feedback ${st.correct ? 'ok' : 'bad'}"><strong>${st.correct ? 'Correct.' : 'Not quite.'}</strong> ${key}
          ${rationale ? `<div class="rationale">${rationale}</div>` : ''}</div>`;
  }
  const original = st.revealed && q.original
    ? `<details class="original"><summary>View the original from the export</summary>${imgHtml(q.original, 'The original question')}</details>` : '';
  const meta = st.hideMeta ? '' : `<div class="meta">${esc(q.domain)} · ${esc(q.skill)} · ${esc(q.difficulty)}${q.source === 'demo' ? ' · demo' : ''}</div>`;
  return `<article class="question">${meta}${prompt}${answer}${feedback}${original}</article>`;
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
    $('#next').focus();
  }
}

// ---------- start: placement or grade ----------

function viewStart() {
  const small = sectionCount('RW') < 15 || sectionCount('MATH') < 15;
  view.innerHTML = `
    <h1>How should we find your level?</h1>
    <p class="muted">Either way, practice keeps adapting to how you actually do. You can change this later.</p>
    <div class="cards">
      <div class="card">
        <h2>Take the placement test</h2>
        <p>About ${PLACEMENT.minItems}–${PLACEMENT.maxItems} questions per section. Questions get harder or easier as you answer, and you'll get an estimated score range and a skill breakdown. Answers aren't shown during the test; any misses go to your Review list.</p>
        <button class="primary" id="placement">Start placement test</button>
      </div>
      <div class="card">
        <h2>Choose your grade</h2>
        <p>Start at a typical level for your grade. Skills usually taught in later courses are held back until you take the placement test.</p>
        <div class="actions">
          <select id="grade" aria-label="Grade">${GRADES.map(g => `<option value="${g}" ${progress.profile.grade === g ? 'selected' : ''}>Grade ${g}</option>`).join('')}</select>
          <button id="use-grade">Use this grade</button>
        </div>
      </div>
    </div>
    ${small ? `<p class="note">Your library has ${sectionCount('RW')} Reading and Writing and ${sectionCount('MATH')} Math questions. Placement results get more reliable as you add more exports.</p>` : ''}`;
  on('#placement', 'click', () => {
    progress.profile.mode = 'placement';
    progress.placement = { RW: null, MATH: null };
    save();
    session = null;
    go('placement/RW');
  });
  on('#use-grade', 'click', () => {
    progress.profile = { mode: 'grade', grade: Number($('#grade').value) };
    progress.placement = { RW: null, MATH: null };
    save();
    go('home');
  });
}

function viewPlacement(arg) {
  const section = arg === 'MATH' ? 'MATH' : 'RW';
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
      <div><div class="eyebrow">Placement test · ${SECTIONS[section].name}</div>
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
    progress.placement[section] = { theta: estimate.theta, se: estimate.se, items: session.answered.length, finishedAt: Date.now() };
    save();
  }
  session = null;
  go(section === 'RW' ? 'placement/MATH' : 'placed');
}

function viewPlaced() {
  const placed = ['RW', 'MATH'].filter(s => progress.placement[s]);
  if (!placed.length) {
    view.innerHTML = `<div class="empty"><h2>No placement results</h2><p>Both sections were skipped. Choose a grade instead, or retake the placement test.</p><a class="button primary" href="#/start">Back</a></div>`;
    return;
  }
  const answers = placed.flatMap(s => progress.responses
    .filter(r => r.source === 'placement' && r.section === s).slice(-progress.placement[s].items));
  const byDomain = DOMAINS.map(d => {
    const rs = answers.filter(r => r.domain === d.name);
    return { d, correct: rs.filter(r => r.correct).length, total: rs.length };
  }).filter(x => x.total);
  const scores = Object.fromEntries(placed.map(s => [s, projectSectionScore(progress.placement[s])]));
  view.innerHTML = `
    <h1>Placement results</h1>
    <div class="cards">
      ${['RW', 'MATH'].map(s => `<div class="card"><div class="eyebrow">${SECTIONS[s].name}</div>
        ${scores[s] ? `<div class="big">${scores[s].mid}</div><div class="range">likely ${scores[s].low}–${scores[s].high} · ${plural(progress.placement[s].items, 'question')}</div>` : '<p class="muted">Skipped</p>'}</div>`).join('')}
      ${scores.RW && scores.MATH ? `<div class="card"><div class="eyebrow">Estimated total</div><div class="big">${scores.RW.mid + scores.MATH.mid}</div><div class="range">likely ${scores.RW.low + scores.MATH.low}–${scores.RW.high + scores.MATH.high}</div></div>` : ''}
    </div>
    <div class="card">
      <h2>By domain</h2>
      <div class="table-wrap"><table><thead><tr><th>Domain</th><th class="num">Correct</th></tr></thead>
      <tbody>${byDomain.map(x => `<tr><td>${esc(x.d.name)}</td><td class="num">${x.correct} / ${x.total}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <p class="note">These ranges are estimates based on your answers and College Board's Easy/Medium/Hard labels. They are not official scores, and they get sharper as you keep practicing.</p>
    <div class="actions"><a class="button primary" href="#/practice">Start practicing</a><a class="button" href="#/home">Go to dashboard</a></div>`;
}

// ---------- practice ----------

function viewPractice(arg) {
  const section = SECTIONS[arg] ? arg : session?.kind === 'practice' ? session.section : 'MATH';
  if (session?.kind !== 'practice' || session.section !== section) {
    session = { kind: 'practice', section, skill: '', done: 0, correct: 0, q: null };
  }
  if (!session.q) {
    session.q = nextPracticeQuestion(pool, progress, section, { skill: session.skill || undefined });
    session.st = newDrillState();
  }
  const skills = skillsForSection(section).filter(s => pool.some(q => q.section === section && q.skill === s.name));
  const header = `
    <header class="bar">
      <div class="seg">${Object.entries(SECTIONS).map(([k, s]) => `<a href="#/practice/${k}" class="${k === section ? 'active' : ''}">${s.name}</a>`).join('')}</div>
      <select id="skill" aria-label="Skill">
        <option value="">Adaptive: focus on weak spots</option>
        ${skills.map(s => `<option ${s.name === session.skill ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
      <span class="tally">${session.correct}/${session.done} this session · ${answeredToday()}/${progress.plan.dailyGoal} today</span>
    </header>`;
  if (!session.q) {
    view.innerHTML = `${header}<div class="empty"><h2>No questions available</h2><p>Add ${SECTIONS[section].name} exports to the <code>exports</code> folder and restart the app${progress.profile.mode === 'grade' ? ', or take the placement test to unlock skills beyond your grade' : ''}.</p><a class="button primary" href="#/library">Open Library</a></div>`;
  } else {
    renderDrill(header, 'practice', () => viewPractice(section));
  }
  on('#skill', 'change', e => { session.skill = e.target.value; session.q = null; viewPractice(section); });
}

// ---------- review ----------

function viewReview(arg) {
  if (arg === 'go') return reviewSession();
  session = null;
  const entries = Object.entries(progress.mistakes).filter(([id]) => byId.has(id)).sort((a, b) => a[1].due - b[1].due);
  const due = entries.filter(([, m]) => m.due <= Date.now()).length;
  const reasons = {};
  for (const [, m] of entries) reasons[m.reason || 'Not tagged'] = (reasons[m.reason || 'Not tagged'] || 0) + 1;
  const maxReason = Math.max(1, ...Object.values(reasons));
  view.innerHTML = `
    <h1>Review</h1>
    <div class="cards">
      <div class="card"><div class="big">${due}</div><div class="muted">due now</div>
        <div class="actions"><button class="primary" id="go" ${due ? '' : 'disabled'}>Review ${plural(due, 'question')}</button></div></div>
      <div class="card"><div class="big">${entries.length}</div><div class="muted">in your mistake log. Each one comes back after 1, 3, 7, 14 and 30 days until you've answered it right five times in a row.</div></div>
      <div class="card"><h3>Why you miss questions</h3>
        ${entries.length ? Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `
          <div class="skill-row"><span class="name">${esc(r)}</span><div class="track"><div class="fill" style="width:${(n / maxReason) * 100}%"></div></div><span class="pct">${n}</span></div>`).join('')
          : '<p class="muted">Nothing yet.</p>'}
      </div>
    </div>
    ${entries.length ? `<div class="card"><h2>Mistake log</h2><div class="table-wrap"><table>
      <thead><tr><th>Question</th><th>Skill</th><th>Difficulty</th><th>Reason</th><th>Next review</th></tr></thead>
      <tbody>${entries.map(([id, m]) => {
        const q = byId.get(id);
        return `<tr><td>${esc(snippet(q))}</td><td>${esc(q.skill)}</td><td>${q.difficulty}</td><td>${esc(m.reason || '—')}</td><td>${m.due <= Date.now() ? 'Now' : new Date(m.due).toLocaleDateString()}</td></tr>`;
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
      view.innerHTML = `<div class="empty"><h2>Review complete</h2><p>${session.correct} of ${session.done} correct. Questions you got right come back later; misses return tomorrow.</p><a class="button primary" href="#/home">Back to dashboard</a></div>`;
      session = null;
      renderNav('review');
      return;
    }
    session.q = byId.get(id);
    session.st = newDrillState();
  }
  const header = `<header class="bar"><div><div class="eyebrow">Review</div><strong>${plural(session.queue.length + 1, 'question')} left</strong></div><span class="tally">${session.correct}/${session.done} correct</span></header>`;
  renderDrill(header, 'review', reviewSession);
}

// ---------- timed practice test ----------

function viewTest() {
  if (test) {
    if (test.finished) return testResults();
    if (test.onBreak) return moduleBreak();
    return testScreen();
  }
  const sizes = { RW: TEST_FORMAT.RW.perModule * 2, MATH: TEST_FORMAT.MATH.perModule * 2 };
  const usable = { RW: testableCount('RW'), MATH: testableCount('MATH') };
  view.innerHTML = `
    <h1>Timed practice test</h1>
    <p>Built like the digital SAT. Each section has two modules. Module 1 mixes easy, medium and hard questions, and how you do on it decides whether module 2 is harder or easier. Reading and Writing modules are ${TEST_FORMAT.RW.perModule} questions in ${TEST_FORMAT.RW.minutes} minutes; Math modules are ${TEST_FORMAT.MATH.perModule} questions in ${TEST_FORMAT.MATH.minutes} minutes.</p>
    <div class="cards">
      ${[['FULL', 'Full test', 'Reading and Writing, then Math', '2 hr 14 min'], ['RW', 'Reading and Writing', 'Two modules', '64 min'], ['MATH', 'Math', 'Two modules', '70 min']].map(([k, title, sub, time]) => `
        <div class="card"><h2>${title}</h2><p class="muted">${sub} · ${time}</p><button class="primary" data-test="${k}" ${(k === 'FULL' ? ['RW', 'MATH'] : [k]).every(sec => usable[sec]) ? '' : 'disabled'}>Start</button></div>`).join('')}
    </div>
    ${usable.RW < sizes.RW || usable.MATH < sizes.MATH ? `<p class="note">A full-length section needs ${sizes.RW} Reading and Writing or ${sizes.MATH} Math questions that can be scored automatically. You have ${usable.RW} and ${usable.MATH}, so modules will be shorter until you add more exports.</p>` : ''}
    ${progress.tests.length ? `<div class="card"><h2>Past tests</h2><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Test</th><th>Reading and Writing</th><th>Math</th></tr></thead>
      <tbody>${[...progress.tests].reverse().map(t => `<tr><td>${new Date(t.at).toLocaleDateString()}</td><td>${esc(t.kind)}</td>
        ${['RW', 'MATH'].map(s => `<td>${t.summary[s] ? `${t.summary[s].score.mid} <span class="muted">(${t.summary[s].correct}/${t.summary[s].total})</span>` : '—'}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></div>` : ''}`;
  on('[data-test]', 'click', e => startTest(e.currentTarget.dataset.test));
}

const testableCount = section => pool.filter(q => q.section === section && gradable(q)).length;

function startTest(kind) {
  test = {
    sections: kind === 'FULL' ? ['RW', 'MATH'] : [kind], sIdx: 0, module: 1, route: null, used: new Set(), results: [],
    panel: null, hideTimer: false, seenBefore: new Set(progress.responses.map(r => r.qid)),
  };
  startModule();
  beginModule();
}

function startModule() {
  const s = test;
  const section = s.sections[s.sIdx];
  const usable = pool.filter(q => q.section === section && gradable(q));
  // A small library is split between the two modules, so module 2 still has questions to be routed to.
  const size = Math.min(TEST_FORMAT[section].perModule, Math.ceil(usable.length / 2));
  // Prefer questions not seen before this test, decided the same way for both modules.
  const unseen = usable.filter(q => !s.seenBefore.has(q.id));
  const source = unseen.length >= size * 2 ? unseen : usable;
  const questions = buildModule(source, section, s.module === 1 ? null : s.route, s.used, size);
  questions.forEach(q => s.used.add(q.id));
  Object.assign(s, { section, questions, idx: 0, answers: {}, eliminated: {}, flags: new Set(), highlights: {}, times: {}, reviewScreen: false, gridOpen: false, highlightMode: false });
}

function beginModule() {
  const s = test;
  s.onBreak = false;
  s.endsAt = Date.now() + TEST_FORMAT[s.section].minutes * 60 * 1000;
  renderNav('test');
  testScreen();
}

function testScreen() {
  const s = test;
  const short = s.questions.length < TEST_FORMAT[s.section].perModule;
  view.innerHTML = `
    <div class="test ${s.highlightMode ? 'highlighting' : ''}">
      <header class="test-bar">
        <div><strong>${SECTIONS[s.section].name}</strong> · Module ${s.module}${short ? ` <span class="muted">(${plural(s.questions.length, 'question')})</span>` : ''}</div>
        <div><span id="timer" class="timer ${s.hideTimer ? 'concealed' : ''}"></span><button class="ghost small" id="toggle-timer">${s.hideTimer ? 'Show timer' : 'Hide'}</button></div>
        <div class="tools">
          ${s.section === 'RW' ? `<button class="ghost small ${s.highlightMode ? 'active' : ''}" id="hl">Highlighter</button>` : ''}
          ${s.section === 'MATH' ? `<button class="ghost small ${s.panel === 'calc' ? 'active' : ''}" data-panel="calc">Calculator</button><button class="ghost small ${s.panel === 'ref' ? 'active' : ''}" data-panel="ref">Reference</button>` : ''}
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
  if (!test || test.finished || test.onBreak) return clearInterval(ticker);
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
  if (s.reviewScreen) {
    const unanswered = s.questions.filter(q => s.answers[q.id] == null).length;
    tq.innerHTML = `
      <div class="card">
        <h2>Check your work</h2>
        <p>${unanswered ? `<span class="warn">${plural(unanswered, 'question')} unanswered.</span> ` : 'Every question has an answer. '}${s.flags.size ? `${plural(s.flags.size, 'question')} flagged for review. ` : ''}Pick a question to revisit it, or submit the module. You can't come back to this module after submitting.</p>
        ${gridHtml()}
        <div class="actions"><button id="back-to-q">Back to questions</button><button class="primary" id="submit-module">Submit module</button></div>
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
      <button class="primary" id="next">${last ? 'Review module' : 'Next'}</button>
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
  passage.addEventListener('mouseup', () => {
    if (!test.highlightMode) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!passage.contains(range.commonAncestorContainer)) return;
    try {
      range.surroundContents(document.createElement('mark'));
    } catch {
      // Selections that cross paragraph boundaries can't be wrapped in a single element.
    }
    sel.removeAllRanges();
  });
  passage.addEventListener('click', e => {
    if (test.highlightMode && e.target.tagName === 'MARK') e.target.replaceWith(...e.target.childNodes);
  });
}

function submitModule() {
  const s = test;
  if (!s || s.finished || s.onBreak) return;
  clearInterval(ticker);
  leaveQuestion();
  const responses = s.questions.map(q => {
    const choice = s.answers[q.id] ?? null;
    const correct = record(q, choice, 'test', s.times[q.id] || 0);
    return { qid: q.id, correct, choice, domain: q.domain, b: DIFFICULTY_B[q.difficulty] ?? 0 };
  });
  s.results.push({ section: s.section, module: s.module, route: s.module === 2 ? s.route : null, responses });
  if (s.module === 1) {
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
  const nextLabel = `${SECTIONS[s.section].name}, module ${s.module}`;
  const newSection = s.module === 1;
  view.innerHTML = `<div class="empty">
    <h2>${newSection ? 'Section complete' : 'Module 1 complete'}</h2>
    <p>Up next: <strong>${nextLabel}</strong> · ${plural(s.questions.length, 'question')} · ${TEST_FORMAT[s.section].minutes} minutes.</p>
    <p class="muted">${newSection ? 'On the real test there is a 10-minute break between sections.' : 'Module 2 has been chosen based on your module 1 results.'} The timer starts when you continue.</p>
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
      score: projectSectionScore(estimateAbility(rs)),
    };
  }
  s.record = {
    id: `t${Date.now()}`, at: Date.now(), kind: s.sections.length === 2 ? 'Full test' : SECTIONS[s.sections[0]].name, summary,
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
  const { summary } = s.record;
  const all = s.results.flatMap(r => r.responses.map(x => ({ ...x, section: r.section, module: r.module })));
  const domainRows = DOMAINS.map(d => {
    const rs = all.filter(r => r.domain === d.name);
    return rs.length ? `<tr><td>${esc(d.name)}</td><td class="num">${rs.filter(r => r.correct).length} / ${rs.length}</td></tr>` : '';
  }).join('');
  view.innerHTML = `
    <h1>Test results</h1>
    <div class="cards">
      ${Object.entries(summary).map(([sec, x]) => `<div class="card"><div class="eyebrow">${SECTIONS[sec].name}</div>
        <div class="big">${x.score.mid}</div><div class="range">likely ${x.score.low}–${x.score.high}</div>
        <p class="muted">${x.correct} of ${x.total} correct${x.route ? ` · you were routed to the ${x.route === 'hard' ? 'harder' : 'easier'} module 2` : ''}</p></div>`).join('')}
      ${summary.RW && summary.MATH ? `<div class="card"><div class="eyebrow">Estimated total</div><div class="big">${summary.RW.score.mid + summary.MATH.score.mid}</div><div class="range">likely ${summary.RW.score.low + summary.MATH.score.low}–${summary.RW.score.high + summary.MATH.score.high}</div></div>` : ''}
    </div>
    <div class="card"><h2>By domain</h2><div class="table-wrap"><table><tbody>${domainRows}</tbody></table></div></div>
    <p class="note">Scores are estimates from your answers and question difficulty, not College Board's official scoring. Missed questions have been added to Review.</p>
    <h2>Every question</h2>
    ${all.map((r, i) => {
      const q = byId.get(r.qid);
      if (!q) return '';
      return `<details class="review-item"><summary><span class="${r.correct ? 'mark-ok' : 'mark-bad'}">${r.correct ? '✓' : '✗'}</span>
        <span>${i + 1}. ${SECTIONS[r.section].short} M${r.module} · ${esc(q.skill)} · ${q.difficulty}${r.choice == null ? ' · <span class="warn">unanswered</span>' : ''}</span></summary>
        ${questionHtml(q, { selected: r.choice, revealed: true, correct: r.correct, hideMeta: true })}</details>`;
    }).join('')}
    <div class="actions"><button class="primary" id="done">Done</button></div>`;
  on('#done', 'click', () => { test = null; go('home'); });
}

const REFERENCE_SHEET = `<div class="ref"><h3>Formulas</h3><p class="hint">Modeled on the SAT math reference sheet.</p><dl>
  <dt>Circle</dt><dd>Area A = πr² · Circumference C = 2πr</dd>
  <dd>A circle has 360° of arc, or 2π radians</dd>
  <dt>Rectangle</dt><dd>A = ℓw</dd>
  <dt>Triangle</dt><dd>A = ½bh · angles sum to 180°</dd>
  <dt>Pythagorean theorem</dt><dd>a² + b² = c²</dd>
  <dt>Special right triangles</dt><dd>30°-60°-90°: x, x√3, 2x</dd><dd>45°-45°-90°: s, s, s√2</dd>
  <dt>Volume</dt><dd>Rectangular prism V = ℓwh</dd><dd>Cylinder V = πr²h</dd><dd>Sphere V = (4/3)πr³</dd><dd>Cone V = (1/3)πr²h</dd><dd>Pyramid V = (1/3)ℓwh</dd>
</dl></div>`;

// ---------- dashboard ----------

function viewHome() {
  if (test?.finished) test = null;
  const est = { RW: sectionEstimate('RW'), MATH: sectionEstimate('MATH') };
  const total = projectedTotal();
  const today = answeredToday();
  const goal = progress.plan.dailyGoal;
  const due = dueMistakes(progress.mistakes).filter(id => byId.has(id)).length;
  const days = daysUntilTest();
  const profile = progress.profile.mode === 'grade'
    ? `Starting level: grade ${progress.profile.grade}`
    : 'Starting level: placement test';

  const scoreCard = (label, s) => `<div class="card"><div class="eyebrow">${label}</div>${s
    ? `<div class="big">${s.mid}</div><div class="range">likely ${s.low}–${s.high}</div>`
    : '<p class="muted">Answer a few more questions to see an estimate.</p>'}</div>`;

  const mastery = section => {
    const skills = skillAbilities(progress, section);
    return DOMAINS.filter(d => d.section === section).map(d => `
      <div class="domain-label">${esc(d.name)}</div>
      ${skills.filter(s => d.skills.some(x => x.name === s.name)).map(s => {
        const p = pCorrect(s.theta, DIFFICULTY_B.Medium);
        return `<div class="skill-row" title="${esc(s.name)}"><span class="name">${esc(s.name)}</span>
          ${s.answered ? `<div class="track"><div class="fill ${masteryClass(p)}" style="width:${Math.round(p * 100)}%"></div></div><span class="pct">${s.correct}/${s.answered}</span>`
            : '<div class="track"></div><span class="pct muted">not started</span>'}</div>`;
      }).join('')}`).join('');
  };

  view.innerHTML = `
    <div class="bar"><h1>Dashboard</h1><span class="muted">${profile} · <a href="#/start">change</a></span></div>
    <div class="cards">
      ${total ? `<div class="card"><div class="eyebrow">Estimated total</div><div class="big">${total.mid}</div><div class="range">likely ${total.low}–${total.high}${progress.plan.target ? ` · target ${progress.plan.target}` : ''}</div></div>` : ''}
      ${scoreCard('Reading and Writing', est.RW)}
      ${scoreCard('Math', est.MATH)}
      <div class="card"><div class="eyebrow">Today</div>
        <div class="big">${today}<span class="muted" style="font-size:1rem"> / ${goal}</span></div>
        <div class="track"><div class="fill ${today >= goal ? 'high' : ''}" style="width:${Math.min(100, (today / goal) * 100)}%"></div></div>
        <p class="muted" style="margin-top:0.5rem">${plural(streakDays(), 'day')} streak${days != null ? ` · ${days >= 0 ? `${plural(days, 'day')} to test day` : 'test date passed'}` : ''}</p>
      </div>
    </div>
    <div class="actions">
      <a class="button primary" href="#/practice/RW">Practice Reading and Writing</a>
      <a class="button primary" href="#/practice/MATH">Practice Math</a>
      <a class="button" href="#/test">Timed practice test</a>
      <a class="button" href="#/review">Review${due ? ` (${due} due)` : ''}</a>
    </div>
    <div class="cards">
      <div class="card"><h2>Reading and Writing skills</h2>${mastery('RW')}</div>
      <div class="card"><h2>Math skills</h2>${mastery('MATH')}</div>
    </div>
    <p class="note">Bar length is your estimated chance of answering a Medium question in that skill correctly. Score ranges are estimates, not official College Board scores.</p>`;
}

// ---------- study plan ----------

function suggestedDailyGoal(days, gap) {
  let goal = 20;
  if (gap > 0) goal += gap / 5;
  if (days != null && days <= 14 && gap > 0) goal += 10;
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
  const weakest = ['RW', 'MATH']
    .flatMap(sec => skillAbilities(progress, sec).filter(s => s.answered >= 2))
    .sort((a, b) => a.theta - b.theta).slice(0, 5);
  const weakerSection = sectionEstimate('RW') && sectionEstimate('MATH')
    ? (sectionEstimate('RW').mid < sectionEstimate('MATH').mid ? 'RW' : 'MATH') : null;

  view.innerHTML = `
    <h1>Study plan</h1>
    <div class="cards">
      <form class="card" id="plan-form">
        <h2>Your goal</h2>
        <label class="field">Test date <input type="date" name="testDate" value="${esc(plan.testDate || '')}"></label>
        <label class="field">Target total score <input type="number" name="target" min="400" max="1600" step="10" value="${plan.target || ''}" placeholder="e.g. 1400"></label>
        <label class="field">Daily question goal <input type="number" name="dailyGoal" min="5" max="150" value="${plan.dailyGoal}"></label>
        <button class="primary">Save</button>
      </form>
      <div class="card">
        <h2>Where you stand</h2>
        <p>${days == null ? 'No test date set.' : days >= 0 ? `<strong>${plural(days, 'day')}</strong> until test day.` : 'Your test date has passed.'}</p>
        <p>${total ? `Estimated total <strong>${total.mid}</strong> (likely ${total.low}–${total.high}).` : 'Practice both sections to get an estimated total.'}</p>
        ${gap != null ? `<p>${gap > 0 ? `About <strong>${gap} points</strong> to your target.` : 'Your estimate is at or above your target. Keep it steady.'}</p>` : ''}
      </div>
    </div>
    <div class="card">
      <h2>Suggested routine</h2>
      <ul>
        <li>Answer <strong>${suggestion} practice questions</strong> a day${weakerSection ? `, leaning toward ${SECTIONS[weakerSection].name}` : ''}.${suggestion !== plan.dailyGoal ? ` <button class="small" id="use-suggestion">Use ${suggestion} as my goal</button>` : ''}</li>
        <li>Clear your due Review questions every day before new practice.</li>
        <li>${testCadence(days)}</li>
      </ul>
      <p class="hint">These suggestions are rules of thumb based on your goal and current estimate.</p>
    </div>
    <div class="card">
      <h2>Focus skills</h2>
      ${weakest.length ? weakest.map(s => `<div class="skill-row"><span class="name">${esc(s.name)} <span class="muted">· ${SECTIONS[s.section].short}</span></span>
        <div class="track"><div class="fill ${masteryClass(pCorrect(s.theta, 0))}" style="width:${Math.round(pCorrect(s.theta, 0) * 100)}%"></div></div>
        <button class="small" data-focus="${esc(s.name)}" data-section="${s.section}">Practice</button></div>`).join('')
        : '<p class="muted">Answer at least two questions in a skill to see where to focus.</p>'}
    </div>`;

  on('#plan-form', 'submit', e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    progress.plan = {
      testDate: f.get('testDate') || null,
      target: Number(f.get('target')) || null,
      dailyGoal: Math.max(5, Number(f.get('dailyGoal')) || 20),
    };
    save();
    viewPlan();
  });
  on('#use-suggestion', 'click', () => { progress.plan.dailyGoal = suggestion; save(); viewPlan(); });
  on('[data-focus]', 'click', e => {
    const { focus, section } = e.currentTarget.dataset;
    session = { kind: 'practice', section, skill: focus, done: 0, correct: 0, q: null };
    go(`practice/${section}`);
  });
}

// ---------- library & settings ----------

function viewLibrary() {
  const rows = DOMAINS.map(d => {
    const qs = pool.filter(q => q.domain === d.name);
    const n = level => qs.filter(q => q.difficulty === level).length;
    return `<tr><td>${SECTIONS[d.section].short}</td><td>${esc(d.name)}</td><td class="num">${n('Easy')}</td><td class="num">${n('Medium')}</td><td class="num">${n('Hard')}</td><td class="num"><strong>${qs.length}</strong></td></tr>`;
  }).join('');
  const addMore = 'save College Board Question Bank PDF exports in the <code>exports</code> folder and restart the app';

  view.innerHTML = `
    <h1>Question library</h1>
    ${library.source === 'demo'
      ? `<p class="note">No College Board questions are built in yet, so ${plural(pool.length, 'demo question')} are in use. To add real ones, ${addMore}.</p>`
      : `<p class="muted">${plural(pool.length, 'question')} from ${plural(library.files, 'export')}. To add more, ${addMore}.</p>`}
    ${library.warnings.length ? `<div class="card"><h2>Skipped questions</h2>${library.warnings.map(w => `<p class="warn">${esc(w)}</p>`).join('')}</div>` : ''}
    <div class="card" style="margin-top:1rem">
      <div class="table-wrap"><table>
        <thead><tr><th>Section</th><th>Domain</th><th class="num">Easy</th><th class="num">Medium</th><th class="num">Hard</th><th class="num">Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h2>Settings</h2>
      <form id="desmos-form" class="field">
        <span>Desmos API key <span class="muted">(optional)</span></span>
        <span class="hint">The real SAT uses the Desmos graphing calculator. Desmos requires an API key to embed it; you can request one at <a href="https://www.desmos.com/my-api" target="_blank" rel="noopener">desmos.com/my-api</a>. Without a key, a built-in scientific calculator is used.</span>
        <div class="actions" style="margin:0.3rem 0 0"><input name="key" value="${esc(getDesmosKey())}" autocomplete="off" spellcheck="false" style="flex:1;min-width:0"><button>Save key</button></div>
      </form>
      <div class="actions"><button class="danger" id="reset">Reset all progress</button></div>
    </div>`;

  on('#desmos-form', 'submit', e => {
    e.preventDefault();
    setDesmosKey(new FormData(e.currentTarget).get('key'));
    e.currentTarget.querySelector('button').textContent = 'Saved';
  });
  confirmButton('#reset', 'Click again to erase progress', () => {
    progress = store.defaultProgress();
    save();
    session = null;
    test = null;
    go('start');
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
  library = result;
  pool = result.questions;
  byId = new Map(pool.map(q => [q.id, q]));
  render();
});
