import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderPage } from '../site/layout.mjs';
import { pages } from '../site/pages.mjs';

// Routes ending in "/" become <route>/index.html so CloudFront and the dev server serve clean URLs.
export const outputPath = (route) => join('dist', route.endsWith('/') ? `${route}index.html` : route);

// Assets are published under /assets/<content hash>/ so every change gets a URL no browser has
// cached. Relative imports between modules keep working because the whole folder moves together.
async function hashDirectory(dir) {
  const hash = createHash('sha256');
  const entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of entries) {
    hash.update(file);
    hash.update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 12);
}

const assetBase = `/assets/${await hashDirectory('src')}/`;

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('src', join('dist', assetBase), { recursive: true });
// public/ holds root-level files (favicons, logo, manifest) that need stable URLs.
await cp('public', 'dist', { recursive: true });

for (const page of pages) {
  const file = outputPath(page.route);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, renderPage(page).replaceAll('"/src/', `"${assetBase}`));
}

console.log(`Built ${pages.length} pages into dist/ (assets at ${assetBase})`);
