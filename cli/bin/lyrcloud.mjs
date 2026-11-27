#!/usr/bin/env node
// The Lyrcloud CLI: build and deploy edge functions to https://<name>.dev.lyr.
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, api } from '../lib/api.mjs';
import { AuthError, browserLogin, decodeJwt, passwordLogin, revoke } from '../lib/auth.mjs';
import { credentialsPath, deleteCredentials, DOCS_URL, FUNCTIONS_DOMAIN, LYR_SETUP_URL, readCredentials } from '../lib/config.mjs';
import { CONFIG_FILE, collectFiles, loadProject, nameError, ProjectError, projectSize } from '../lib/project.mjs';
import { ask, bold, cyan, dim, fail, formatBytes, ok, relativeTime, table, warn } from '../lib/ui.mjs';
import { createZip } from '../lib/zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const MAX_ZIP = 4 * 1024 * 1024;

const HELP = `${bold('lyrcloud')} ${dim(`v${version}`)} — deploy edge functions to https://<name>.${FUNCTIONS_DOMAIN}

${bold('Usage')}
  lyrcloud <command> [options]

${bold('Commands')}
  login [--email]          Sign in (opens your browser; --email for email and password)
  logout                   Sign out on this computer
  whoami                   Show who you're signed in as
  init <name>              Create a new function project in ./<name>
  dev [--port 8787]        Run the project locally, reloading on changes
  deploy [--name <name>]   Upload the project and make it live
  list                     List your functions
  logs [name] [-f] [--since 15m]   Show recent logs (-f keeps following)
  delete [name] [--yes]    Take a function down and free its name

${bold('Storage')}
  storage                          Namespaces and buckets your functions use
  kv list <ns> [--prefix p]        List keys in a KV namespace
  kv get <ns> <key>                Print a value
  kv put <ns> <key> <value> [--ttl 3600]   Store a value (or --file <path>)
  kv delete <ns> <key>             Delete a key
  bucket list <bucket> [--prefix p]        List files in a bucket
  bucket put <bucket> <key> <file>         Upload a file (up to 4 MB)
  bucket get <bucket> <key> [--out path]   Download a file
  bucket delete <bucket> <key>             Delete a file

${bold('AI')}
  ai models                        Models you can use on your plan
  ai run [model] "<prompt>" [--system s] [--max-tokens n]   Ask a model
  ai usage [--month YYYY-MM]       Tokens used this month, by model

${bold('Options')}
  -h, --help               Show help
  -v, --version            Show the version

Docs: ${DOCS_URL}`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const aliases = { f: 'follow', y: 'yes', p: 'port', h: 'help', v: 'version', n: 'name' };
  const valued = new Set(['port', 'since', 'name', 'prefix', 'ttl', 'file', 'out', 'type', 'system', 'max-tokens', 'month']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const long = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    const short = /^-([a-zA-Z])$/.exec(arg);
    if (long || short) {
      const key = long ? long[1] : aliases[short[1]] || short[1];
      if (long && long[2] !== undefined) flags[key] = long[2];
      else if (valued.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags[key] = argv[(i += 1)];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

class UsageError extends Error {}

// ---------------------------------------------------------------- commands

async function login(_, flags) {
  if (flags.email) {
    const email = typeof flags.email === 'string' ? flags.email : await ask('Email: ');
    const password = await ask('Password: ', { hidden: true });
    if (!email || !password) throw new UsageError('Enter your email and password.');
    const who = await passwordLogin(email, password);
    ok(`Signed in as ${bold(who.email || email)}`);
    return;
  }
  const provider = flags.google ? 'GoogleOIDC' : undefined;
  const who = await browserLogin({ provider });
  ok(`Signed in as ${bold(who.email || who.name || 'your Lyrcloud account')}`);
}

async function logout() {
  await revoke();
  if (deleteCredentials()) ok('Signed out.');
  else console.log('You weren’t signed in.');
}

async function whoami() {
  const credentials = readCredentials();
  if (!credentials?.idToken) {
    console.log('Not signed in. Run lyrcloud login.');
    process.exitCode = 1;
    return;
  }
  const claims = decodeJwt(credentials.idToken);
  console.log(`${bold(credentials.email || claims.email || 'Signed in')}${credentials.name ? ` (${credentials.name})` : ''}`);
  console.log(dim(`Credentials: ${credentialsPath()}`));
}

const TEMPLATE = `// Your edge function. Every request to https://<name>.${FUNCTIONS_DOMAIN} calls fetch().
// request is a standard Request; return a standard Response.
// env holds the "vars" from lyrcloud.json. ctx.waitUntil(promise) finishes work after responding.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/time') {
      return Response.json({ now: new Date().toISOString() });
    }

    return new Response(\`\${env.GREETING} from \${url.hostname}!\\n\`, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
`;

async function init([name], flags) {
  if (!name) throw new UsageError('Give the project a name: lyrcloud init <name>');
  const problem = nameError(name);
  if (problem) throw new UsageError(problem);
  const dir = path.resolve(name);
  if (existsSync(dir) && readdirSync(dir).length && !flags.force) throw new UsageError(`${name}/ already exists and isn’t empty. Use --force to write into it.`);
  mkdirSync(dir, { recursive: true });
  const files = {
    [CONFIG_FILE]: `${JSON.stringify({ name, main: 'index.js', vars: { GREETING: 'Hello' } }, null, 2)}\n`,
    'index.js': TEMPLATE.replace('<name>', name),
    'package.json': `${JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', scripts: { dev: 'lyrcloud dev', deploy: 'lyrcloud deploy' } }, null, 2)}\n`,
    '.gitignore': 'node_modules/\n.lyrcloud/\n.env\n',
  };
  for (const [file, content] of Object.entries(files)) {
    if (existsSync(path.join(dir, file)) && !flags.force) continue;
    writeFileSync(path.join(dir, file), content);
  }
  ok(`Created ${bold(name)} in ./${path.relative(process.cwd(), dir) || '.'}`);
  console.log(`
  cd ${name}
  lyrcloud dev      ${dim('# try it at http://localhost:8787')}
  lyrcloud deploy   ${dim(`# go live at https://${name}.${FUNCTIONS_DOMAIN}`)}`);
}

async function dev(_, flags) {
  const { root, config } = loadProject();
  const port = Number(flags.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('Use a port between 1 and 65535.');
  let child;
  let restarting = false;
  const start = (first) => {
    child = fork(path.join(here, '..', 'lib', 'dev-server.mjs'), [root, String(port)], { stdio: 'inherit' });
    child.once('message', () => {
      if (first) {
        ok(`${bold(config.name || 'Your function')} is running at ${cyan(`http://localhost:${port}`)}`);
        console.log(dim('Edits reload automatically. Press Ctrl+C to stop.\n'));
      } else {
        console.log(dim('↻ reloaded'));
      }
    });
    child.once('exit', (code) => {
      if (!restarting && code) {
        fail('The dev server stopped.');
        process.exit(code);
      }
    });
  };
  start(true);
  let timer;
  const ignored = /(^|[/\\])(node_modules|\.git|\.lyrcloud)([/\\]|$)|\.log$|~$|\.sw[px]$/;
  try {
    watch(root, { recursive: true }, (_event, file) => {
      if (file && ignored.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        restarting = true;
        child.once('exit', () => {
          restarting = false;
          start(false);
        });
        child.kill();
      }, 150);
    });
  } catch {
    warn('This system can’t watch folders, so restart lyrcloud dev after editing.');
  }
  const stop = () => {
    child?.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

async function deploy(_, flags) {
  const { root, config } = loadProject();
  const name = typeof flags.name === 'string' ? flags.name : config.name;
  if (!name) throw new UsageError(`Set "name" in ${CONFIG_FILE} or pass --name.`);
  const problem = nameError(name);
  if (problem) throw new UsageError(problem);
  const files = collectFiles(root, config);
  const zip = createZip(files);
  if (zip.length > MAX_ZIP) {
    throw new UsageError(`The project is ${formatBytes(zip.length)} zipped; functions can be at most ${formatBytes(MAX_ZIP)}. Leave out large files with "exclude" in ${CONFIG_FILE}, or bundle your code.`);
  }
  console.log(dim(`Uploading ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(projectSize(files))}, ${formatBytes(zip.length)} zipped)…`));
  const started = Date.now();
  const { function: fn } = await api('PUT', `/functions/${name}`, { body: { code: zip.toString('base64'), main: config.main, vars: config.vars || {}, kv: config.kv, buckets: config.buckets, ai: config.ai } });
  ok(`Deployed ${bold(name)} ${dim(`in ${((Date.now() - started) / 1000).toFixed(1)}s`)}`);
  console.log(`  ${cyan(fn.url)}`);
  if (fn.deploys === 1) {
    console.log(dim('\n  New addresses take about a minute to start answering.'));
    console.log(dim(`  .lyr addresses open on devices set up for Lyr DNS: ${LYR_SETUP_URL}`));
  }
}

async function list() {
  const { functions, limit, plan } = await api('GET', '/functions');
  if (!functions.length) {
    console.log(`No functions yet. Create one with ${bold('lyrcloud init <name>')}.`);
    return;
  }
  table(functions.map((fn) => [fn.name, fn.status, fn.url, relativeTime(fn.updatedAt || fn.createdAt)]), ['NAME', 'STATUS', 'URL', 'UPDATED']);
  console.log(dim(`\n${functions.length} of ${limit} functions on the ${plan} plan`));
}

function nameFor(args, flags) {
  if (args[0]) return args[0];
  if (typeof flags.name === 'string') return flags.name;
  try {
    const { config } = loadProject();
    if (config.name) return config.name;
  } catch {
    // no project here
  }
  throw new UsageError('Name the function, or run this inside its project folder.');
}

async function logs(args, flags) {
  const name = nameFor(args, flags);
  const since = typeof flags.since === 'string' ? flags.since : '15m';
  const seen = new Set();
  const print = (events) => {
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      console.log(`${dim(event.time.replace('T', ' ').slice(0, 19))} ${event.message}`);
    }
  };
  let next = null;
  let printed = 0;
  do {
    const page = await api('GET', `/functions/${name}/logs`, { query: { since, next } });
    print(page.events);
    printed += page.events.length;
    next = page.next;
  } while (next);
  if (!flags.follow) {
    if (!printed) console.log(dim(`No logs for ${name} in the last ${since}.`));
    return;
  }
  console.log(dim(`Following ${name}… (Ctrl+C to stop)`));
  let from = Date.now() - 5000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const page = await api('GET', `/functions/${name}/logs`, { query: { since: String(from) } });
    print(page.events);
    if (page.events.length) from = Math.max(from, Date.parse(page.events.at(-1).time) - 1000);
    if (seen.size > 5000) seen.clear();
  }
}

async function remove(args, flags) {
  const name = nameFor(args, flags);
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new UsageError(`Add --yes to delete ${name} without a prompt.`);
    const answer = await ask(`Delete ${bold(name)} and take https://${name}.${FUNCTIONS_DOMAIN} offline? Type the name to confirm: `);
    if (answer !== name) {
      console.log('Nothing deleted.');
      return;
    }
  }
  await api('DELETE', `/functions/${name}`);
  ok(`Deleted ${bold(name)}.`);
}

// ---------------------------------------------------------------- storage

const enc = (part) => encodeURIComponent(part);
const need = (value, usage) => {
  if (!value) throw new UsageError(`Usage: lyrcloud ${usage}`);
  return value;
};
const typeFor = (file) => ({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
}[path.extname(file).toLowerCase()] || 'application/octet-stream');

async function storage() {
  const { kv, buckets } = await api('GET', '/storage');
  if (!kv.length && !buckets.length) {
    console.log(`None yet. Add ${bold('"kv": { "CACHE": "my-cache" }')} or ${bold('"buckets": { "FILES": "uploads" }')} to lyrcloud.json and deploy.`);
    return;
  }
  if (kv.length) console.log(`${bold('KV namespaces')}\n${kv.map((name) => `  ${name}`).join('\n')}`);
  if (buckets.length) console.log(`${bold('Buckets')}\n${buckets.map((name) => `  ${name}`).join('\n')}`);
}

async function kvCommand([action, ns, key, value], flags) {
  const usage = 'kv list|get|put|delete <namespace> [key] [value]';
  need(action, usage);
  need(ns, usage);
  const base = `/storage/kv/${enc(ns)}/keys`;
  if (action === 'list' || action === 'ls') {
    let cursor;
    let count = 0;
    do {
      const page = await api('GET', base, { query: { prefix: flags.prefix, cursor } });
      for (const item of page.keys) {
        console.log(item.expiration ? `${item.name}  ${dim(`expires ${new Date(item.expiration * 1000).toISOString()}`)}` : item.name);
      }
      count += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    if (!count) console.log(dim(`No keys${flags.prefix ? ` starting with ${flags.prefix}` : ''} in ${ns}.`));
    return;
  }
  need(key, usage);
  const url = `${base}/${enc(key)}`;
  if (action === 'get') {
    const found = await api('GET', url);
    process.stdout.write(Buffer.from(found.value, 'base64'));
    if (process.stdout.isTTY) process.stdout.write('\n');
    return;
  }
  if (action === 'put') {
    let bytes;
    if (typeof flags.file === 'string') bytes = readFileSync(flags.file);
    else if (value !== undefined) bytes = Buffer.from(value);
    else throw new UsageError('Give a value, or --file <path>.');
    const ttl = flags.ttl === undefined ? undefined : Number(flags.ttl);
    if (ttl !== undefined && !(ttl >= 60)) throw new UsageError('--ttl is in seconds, at least 60.');
    await api('PUT', url, { body: { value: bytes.toString('base64'), expirationTtl: ttl } });
    ok(`Stored ${bold(key)} in ${ns} ${dim(`(${formatBytes(bytes.length)}${ttl ? `, expires in ${ttl}s` : ''})`)}`);
    return;
  }
  if (action === 'delete' || action === 'rm') {
    await api('DELETE', url);
    ok(`Deleted ${bold(key)} from ${ns}.`);
    return;
  }
  throw new UsageError(`Usage: lyrcloud ${usage}`);
}

async function bucketCommand([action, bucket, key, file], flags) {
  const usage = 'bucket list|put|get|delete <bucket> [key] [file]';
  need(action, usage);
  need(bucket, usage);
  const base = `/storage/buckets/${enc(bucket)}/objects`;
  if (action === 'list' || action === 'ls') {
    const rows = [];
    let cursor;
    do {
      const page = await api('GET', base, { query: { prefix: flags.prefix, cursor } });
      rows.push(...page.objects.map((item) => [item.key, formatBytes(item.size), relativeTime(item.uploaded)]));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (!rows.length) console.log(dim(`No files${flags.prefix ? ` starting with ${flags.prefix}` : ''} in ${bucket}.`));
    else table(rows, ['KEY', 'SIZE', 'UPLOADED']);
    return;
  }
  need(key, usage);
  const url = `${base}/${key.split('/').map(enc).join('/')}`;
  if (action === 'put') {
    const source = file || (typeof flags.file === 'string' ? flags.file : null);
    if (!source) throw new UsageError('Usage: lyrcloud bucket put <bucket> <key> <file>');
    const bytes = readFileSync(source);
    if (bytes.length > MAX_ZIP) throw new UsageError(`Files can be at most ${formatBytes(MAX_ZIP)}.`);
    const contentType = typeof flags.type === 'string' ? flags.type : typeFor(source);
    await api('PUT', url, { body: { body: bytes.toString('base64'), contentType } });
    ok(`Uploaded ${bold(key)} to ${bucket} ${dim(`(${formatBytes(bytes.length)}, ${contentType})`)}`);
    return;
  }
  if (action === 'get') {
    const found = await api('GET', url);
    const bytes = Buffer.from(found.body, 'base64');
    if (typeof flags.out === 'string') {
      writeFileSync(flags.out, bytes);
      ok(`Saved ${bold(key)} to ${flags.out} ${dim(`(${formatBytes(bytes.length)})`)}`);
    } else {
      process.stdout.write(bytes);
    }
    return;
  }
  if (action === 'delete' || action === 'rm') {
    await api('DELETE', url);
    ok(`Deleted ${bold(key)} from ${bucket}.`);
    return;
  }
  throw new UsageError(`Usage: lyrcloud ${usage}`);
}

// ---------------------------------------------------------------- AI

async function aiCommand([action, ...rest], flags) {
  if (action === 'models') {
    const { models, plan } = await api('GET', '/ai/models');
    table(models.map((m) => [m.name, m.kind, m.available ? m.note : `${m.note} ${dim('(not on your plan)')}`]), ['MODEL', 'KIND', '']);
    console.log(dim(`\nYou’re on the ${plan} plan. Use a model with env.AI.run('<model>', { prompt }) or lyrcloud ai run.`));
    return;
  }
  if (action === 'usage') {
    const usage = await api('GET', '/ai/usage', { query: { month: flags.month } });
    if (!usage.models.length) console.log(dim(`No AI use in ${usage.month}.`));
    else table(usage.models.map((m) => [m.model, m.requests, m.inputTokens.toLocaleString('en-US'), m.outputTokens.toLocaleString('en-US'), m.cachedRequests]), ['MODEL', 'REQUESTS', 'INPUT TOKENS', 'OUTPUT TOKENS', 'CACHED']);
    const pct = Math.min(100, Math.round((usage.weightedTokens / usage.limits.monthlyTokens) * 100));
    console.log(dim(`\n${usage.weightedTokens.toLocaleString('en-US')} of ${usage.limits.monthlyTokens.toLocaleString('en-US')} plan tokens used in ${usage.month} (${pct}%), up to ${usage.limits.perMinute} requests a minute.`));
    return;
  }
  if (action === 'run') {
    const [model, prompt] = rest.length > 1 ? rest : [undefined, rest[0]];
    if (!prompt) throw new UsageError('Usage: lyrcloud ai run [model] "<prompt>"');
    const input = { prompt };
    if (typeof flags.system === 'string') input.system = flags.system;
    if (flags['max-tokens'] !== undefined) input.max_tokens = Number(flags['max-tokens']);
    const out = await api('POST', '/ai/run', { body: { model, input } });
    console.log(out.response);
    console.error(dim(`\n${out.model} · ${out.usage.input_tokens} in / ${out.usage.output_tokens} out${out.cached ? ' · cached' : ''}`));
    return;
  }
  throw new UsageError('Usage: lyrcloud ai models | run [model] "<prompt>" | usage');
}

const COMMANDS = { login, logout, whoami, init, dev, deploy, list, ls: list, logs, tail: logs, delete: remove, rm: remove, storage, kv: kvCommand, bucket: bucketCommand, buckets: bucketCommand, ai: aiCommand };

// ---------------------------------------------------------------- main

const { command, args, flags } = parseArgs(process.argv.slice(2));
if (flags.version && !command) {
  console.log(version);
} else if (!command || flags.help || command === 'help') {
  console.log(HELP);
} else if (!COMMANDS[command]) {
  fail(`Unknown command “${command}”.`);
  console.log(`\n${HELP}`);
  process.exitCode = 1;
} else {
  try {
    await COMMANDS[command](args, flags);
  } catch (err) {
    if (err instanceof UsageError || err instanceof ProjectError || err instanceof AuthError || err instanceof ApiError) {
      fail(err.message);
    } else {
      fail(err.stack || String(err));
    }
    process.exitCode = 1;
  }
}
