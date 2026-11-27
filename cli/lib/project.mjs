// A Lyrcloud project: a folder with lyrcloud.json ({ name, main, vars? }) and your code.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'lyrcloud.json';

export class ProjectError extends Error {}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const nameError = (name) => (typeof name === 'string' && NAME_RE.test(name) && name.slice(2, 4) !== '--'
  ? null
  : 'Names use 1–40 lowercase letters, digits and hyphens, and start and end with a letter or digit.');

// Walks up from `dir` to the folder holding lyrcloud.json.
export function findProject(dir = process.cwd()) {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadProject(dir = process.cwd()) {
  const root = findProject(dir);
  if (!root) throw new ProjectError(`No ${CONFIG_FILE} here. Create a project with lyrcloud init <name>, or cd into one.`);
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
  } catch (err) {
    throw new ProjectError(`${CONFIG_FILE} isn’t valid JSON: ${err.message}`);
  }
  // A project with "assets" and no "main" (or no index.js) is a static site.
  const assetsDir = typeof config.assets === 'string' ? config.assets : config.assets?.dir;
  if (assetsDir && !existsSync(path.join(root, assetsDir))) throw new ProjectError(`The assets folder ${assetsDir} (set by "assets" in ${CONFIG_FILE}) doesn’t exist.`);
  let main = config.main || 'index.js';
  if (!existsSync(path.join(root, main))) {
    if (assetsDir && !config.main) main = null;
    else throw new ProjectError(`The entry file ${main} (set by "main" in ${CONFIG_FILE}) doesn’t exist.`);
  }
  return { root, config: { ...config, main } };
}

// Folders and files never uploaded.
const SKIP = new Set(['.git', '.hg', '.svn', '.lyrcloud', '.DS_Store', '.env', 'node_modules']);

function walk(root, rel, out, skip) {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (SKIP.has(entry.name) || skip(relPath)) continue;
    if (entry.isDirectory()) walk(root, relPath, out, skip);
    else if (entry.isFile()) out.push(relPath);
  }
}

// The packages listed in package.json "dependencies", and what they depend on, from node_modules.
function dependencyFolders(root) {
  const folders = new Set();
  const visit = (from) => {
    let meta;
    try {
      meta = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'));
    } catch {
      return;
    }
    for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
      // Node looks in the nearest node_modules first, then the project's.
      const candidates = [path.join(from, 'node_modules', dep), path.join(root, 'node_modules', dep)];
      const found = candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')));
      if (!found || folders.has(found)) continue;
      folders.add(found);
      visit(found);
    }
  };
  visit(root);
  return [...folders];
}

// Every file to upload as [{ name, data }], with a package.json that marks .js files as ES modules when
// the project has none.
export function collectFiles(root, config) {
  const ignore = (config.exclude || []).map((pattern) => String(pattern).replace(/\/$/, ''));
  const skip = (rel) => ignore.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`));
  const names = [];
  walk(root, '', names, skip);
  for (const folder of dependencyFolders(root)) {
    const rel = path.relative(root, folder).split(path.sep).join('/');
    const inner = [];
    walk(folder, '', inner, () => false);
    // node_modules inside a dependency are reached by their own entries in dependencyFolders.
    names.push(...inner.map((name) => `${rel}/${name}`));
  }
  const files = names.sort().map((name) => ({ name, data: readFileSync(path.join(root, name)) }));
  if (!files.some((file) => file.name === 'package.json')) files.push({ name: 'package.json', data: Buffer.from('{ "type": "module" }\n') });
  return files;
}

export function projectSize(files) {
  return files.reduce((sum, file) => sum + file.data.length, 0);
}

export const isDir = (target) => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};
