import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// GitHub Pages lets browsers cache files for 10 minutes. Every module the app loads is versioned through
// index.html's import map; one left out could run as a stale cached copy next to newer files after a deploy.
test('the import map versions every module the app loads', () => {
  const html = read('index.html');
  const { imports } = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  const seen = new Set();
  const queue = ['app.js'];
  while (queue.length) {
    for (const [, dep] of read(`js/${queue.shift()}`).matchAll(/from '\.\/([\w-]+\.js)'/g)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  assert.ok(seen.size > 5, 'found the module graph');
  for (const dep of seen) assert.equal(imports[`./js/${dep}`], `./js/${dep}?v=__VERSION__`, `${dep} is missing from the import map`);
  assert.match(html, /src="js\/app\.js\?v=__VERSION__"/);
  assert.match(html, /href="css\/app\.css\?v=__VERSION__"/);
});

test('the Pages deploy stamps the version into index.html', () => {
  assert.match(read('.github/workflows/pages.yml'), /s\/__VERSION__\//);
});
