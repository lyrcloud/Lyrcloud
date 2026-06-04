import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT || 5173);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`);
  const normalizedPath = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const safePath = normalizedPath.startsWith('..') ? 'index.html' : normalizedPath;
  const filePath = join(root, safePath === '' ? 'index.html' : safePath);
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': types.get(extname(filePath)) || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Lyrcloud dev server running at http://localhost:${port}`);
});
