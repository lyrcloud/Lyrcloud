// Project rules, the build script's settings and the CloudFront router.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  cleanUrlCopies,
  contentTypeFor,
  parseGitUrl,
  projectNameError,
  repoNameError,
  settingsError,
  siteMode,
  slugify,
} from './rules.mjs';

test('project names are safe subdomains', () => {
  assert.equal(slugify('  My Café Site!! '), 'my-cafe-site');
  assert.equal(projectNameError('my-site'), null);
  for (const bad of ['ab', '-site', 'site-', 'Site', 'my_site', 'a--b', 'www', 'paypal', 'x'.repeat(41)]) assert.ok(projectNameError(bad), bad);
});

test('git URLs from every host', () => {
  assert.deepEqual(parseGitUrl('https://github.com/vercel/next.js/tree/canary'), {
    host: 'github.com', provider: 'github', owner: 'vercel', repo: 'next.js',
    cloneUrl: 'https://github.com/vercel/next.js.git', webUrl: 'https://github.com/vercel/next.js', branch: 'canary',
  });
  assert.equal(parseGitUrl('git@github.com:o/r.git').cloneUrl, 'https://github.com/o/r.git');
  assert.equal(parseGitUrl('github.com/o/r').repo, 'r');
  const lab = parseGitUrl('https://gitlab.com/group/sub/app/-/tree/feature/x');
  assert.equal(lab.owner, 'group/sub');
  assert.equal(lab.branch, 'feature/x');
  assert.equal(parseGitUrl('https://bitbucket.org/team/site/src/main/').branch, 'main');
  assert.equal(parseGitUrl('https://git.example.org/me/site.git').provider, 'git');
  for (const bad of ['http://github.com/o/r', 'https://user:pw@github.com/o/r', 'https://localhost/r', 'https://10.0.0.1/r',
    'https://github.com/o', 'https://github.com/o/r;rm', 'file:///etc', 'https://metadata.internal/x']) {
    assert.equal(parseGitUrl(bad), null, bad);
  }
});

test('build settings stay inside the repository', () => {
  assert.equal(settingsError({ branch: 'main', rootDir: 'apps/web', outputDir: 'dist', buildCommand: 'npm run build' }), null);
  assert.ok(settingsError({ rootDir: '../x' }));
  assert.ok(settingsError({ outputDir: '/etc' }));
  assert.ok(settingsError({ buildCommand: 'a\nb' }));
  assert.ok(settingsError({ secret: 'x' }));
  assert.equal(repoNameError('my-site.copy'), null);
  assert.ok(repoNameError('a/b'));
});

test('publishing: content types, site modes and clean URLs', () => {
  assert.equal(contentTypeFor('a/b/app.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
  assert.equal(siteMode(['index.html', 'assets/app.js', '404.html']), 'spa');
  assert.equal(siteMode(['index.html', 'about.html']), 'static');
  assert.deepEqual(cleanUrlCopies(['index.html', 'about.html', 'docs/intro.html', 'docs/intro/index.html', '404.html']), [['about.html', 'about/index.html']]);
});

// Runs the CloudFront Function source in Node with a fake KeyValueStore.
async function loadRouter(entries) {
  const source = (await readFile(new URL('../../infra/cloudfront/sites-router.js', import.meta.url), 'utf8'))
    .replace("import cf from 'cloudfront';", '')
    .replaceAll('__DOMAIN__', 'lyrcloud.app');
  const cf = { kvs: () => ({ get: async (key) => { if (!(key in entries)) throw new Error('not found'); return entries[key]; } }) };
  return new Function('cf', `${source}; return handler;`)(cf);
}

test('the router maps subdomains to the live deployment', async () => {
  const handler = await loadRouter({ blog: 'p1/d1|static', app: 'p2/d2|spa' });
  const route = async (host, uri) => {
    const result = await handler({ request: { uri, headers: { host: { value: host } } } });
    return result.uri ?? result.headers.location.value;
  };
  assert.equal(await route('blog.lyrcloud.app', '/'), '/sites/p1/d1/index.html');
  assert.equal(await route('blog.lyrcloud.app', '/about'), '/sites/p1/d1/about/index.html');
  assert.equal(await route('blog.lyrcloud.app', '/css/site.css'), '/sites/p1/d1/css/site.css');
  assert.equal(await route('app.lyrcloud.app', '/settings/profile'), '/sites/p2/d2/index.html');
  assert.equal(await route('app.lyrcloud.app', '/assets/app.js'), '/sites/p2/d2/assets/app.js');
  assert.equal(await route('nope.lyrcloud.app', '/'), '/_lyrcloud/404.html');
  assert.equal(await route('a.b.lyrcloud.app', '/'), '/_lyrcloud/404.html');
  assert.equal(await route('blog.lyrcloud.app', '/../p2/d2/secret'), '/sites/p1/d1/index.html');
  assert.equal(await route('lyrcloud.app', '/'), 'https://www.lyrcloud.com/');
});
