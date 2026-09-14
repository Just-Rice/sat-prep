// Builds the question library from exports/, then serves the app on localhost: `npm start`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuestions } from './scripts/build-questions.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5190;
const PRIVATE = ['/node_modules', '/exports', '/scripts', '/tests', '/data/cache'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

try {
  await buildQuestions();
} catch (err) {
  console.error('Could not build questions from exports/:', err);
}

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (path.includes('..') || path.startsWith('/.') || PRIVATE.some(p => path === p || path.startsWith(`${p}/`))) {
    res.writeHead(404).end();
    return;
  }
  const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`SAT Prep running at http://localhost:${PORT}`));
