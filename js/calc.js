// Calculator panel. With a Desmos API key (saved in Library → Settings) it embeds the Desmos graphing
// calculator the real test uses; without one it falls back to a built-in scientific calculator.

const KEY_STORAGE = 'satprep.desmosKey';

export function getDesmosKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

export function setDesmosKey(key) {
  try { key ? localStorage.setItem(KEY_STORAGE, key.trim()) : localStorage.removeItem(KEY_STORAGE); } catch { /* storage unavailable */ }
}

let desmosLoad;
function loadDesmos(key) {
  desmosLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${encodeURIComponent(key)}`;
    s.onload = () => resolve(window.Desmos);
    s.onerror = () => { desmosLoad = null; reject(new Error('Desmos failed to load')); };
    document.head.appendChild(s);
  });
  return desmosLoad;
}

export async function mountCalculator(container) {
  const key = getDesmosKey();
  if (key) {
    try {
      const Desmos = await loadDesmos(key);
      container.innerHTML = '<div class="desmos"></div>';
      Desmos.GraphingCalculator(container.firstChild, { expressionsCollapsed: false });
      return;
    } catch { /* fall through to the built-in calculator */ }
  }
  mountScientific(container, key ? 'Desmos could not load, so the built-in calculator is shown.' : 'Add a Desmos API key in Library → Settings to use the graphing calculator.');
}

function mountScientific(container, note) {
  container.innerHTML = `
    <form class="sci">
      <input name="expr" placeholder="e.g. sqrt(3^2+4^2)" autocomplete="off" spellcheck="false">
      <div class="sci-row">
        <label><input type="checkbox" name="deg" checked> Degrees</label>
        <button>=</button>
      </div>
      <ol class="sci-history"></ol>
      <p class="hint">${note} Supports + − × ÷ ^, parentheses, sqrt, sin, cos, tan, asin, acos, atan, log, ln, abs, pi, e.</p>
    </form>`;
  const form = container.querySelector('form');
  const history = form.querySelector('.sci-history');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const expr = form.expr.value;
    let out;
    try { out = format(evaluate(expr, { degrees: form.deg.checked })); } catch (err) { out = err.message; }
    const li = document.createElement('li');
    li.textContent = `${expr} = ${out}`;
    history.prepend(li);
    form.expr.select();
  });
}

function format(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

// Recursive-descent evaluator: no eval, so pasted text can't run code.
export function evaluate(input, { degrees = true } = {}) {
  const tokens = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, 'pi')
    .match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z]+|[-+*/^()]|\S/gi) || [];
  let i = 0;
  const peek = () => tokens[i];
  const take = t => { if (tokens[i] !== t) throw new Error(`Expected ${t}`); i++; };
  const toRad = x => (degrees ? (x * Math.PI) / 180 : x);
  const fromRad = x => (degrees ? (x * 180) / Math.PI : x);
  const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10,
    sin: x => Math.sin(toRad(x)), cos: x => Math.cos(toRad(x)), tan: x => Math.tan(toRad(x)),
    asin: x => fromRad(Math.asin(x)), acos: x => fromRad(Math.acos(x)), atan: x => fromRad(Math.atan(x)),
  };

  function expression() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = unary();
    for (;;) {
      if (peek() === '*' || peek() === '/') v = tokens[i++] === '*' ? v * unary() : v / unary();
      else if (peek() === '(' || /^[a-z\d.]/i.test(peek() || '')) v *= unary(); // implicit: 2pi, 3(4)
      else return v;
    }
  }
  function unary() {
    if (peek() === '-') { i++; return -unary(); }
    if (peek() === '+') { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek() === '^') { i++; return base ** unary(); }
    return base;
  }
  function atom() {
    const t = tokens[i++];
    if (t === undefined) throw new Error('Incomplete expression');
    if (t === '(') { const v = expression(); take(')'); return v; }
    if (/^\d|^\./.test(t)) return Number(t);
    const name = t.toLowerCase();
    if (name === 'pi') return Math.PI;
    if (name === 'e') return Math.E;
    if (FUNCS[name]) { take('('); const v = expression(); take(')'); return FUNCS[name](v); }
    throw new Error(`Unknown "${t}"`);
  }

  const value = expression();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i]}"`);
  if (!Number.isFinite(value)) throw new Error('Undefined');
  return value;
}
