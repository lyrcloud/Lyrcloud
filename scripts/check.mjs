import { readFile } from 'node:fs/promises';

const files = ['index.html', 'src/styles.css', 'src/main.js'];
for (const file of files) {
  const text = await readFile(file, 'utf8');
  if (!text.trim()) throw new Error(`${file} is empty`);
}
const html = await readFile('index.html', 'utf8');
for (const required of ['Lyrcloud', 'www.lyrcloud.com', 'Start building', 'Pricing']) {
  if (!html.includes(required)) throw new Error(`Missing required content: ${required}`);
}
console.log('Static content checks passed');
