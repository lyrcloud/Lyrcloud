# lyrcloud

The Lyrcloud CLI. Write a `fetch` handler, try it locally, and deploy it to `https://<name>.dev.lyr`.

```bash
npm install -g lyrcloud
lyrcloud login
lyrcloud init hello-edge
cd hello-edge
lyrcloud dev       # http://localhost:8787
lyrcloud deploy    # https://hello-edge.dev.lyr
```

Requires Node.js 20 or newer. No dependencies.

## Your function

```js
export default {
  async fetch(request, env, ctx) {
    return new Response(`${env.GREETING} from ${new URL(request.url).hostname}`);
  },
};
```

- `request` is a standard `Request`. `request.geo.ip` is the visitor's IP address.
- `env` holds the `vars` from `lyrcloud.json`.
- `ctx.waitUntil(promise)` finishes work after the response is ready.
- Return a standard `Response`.

## Storage

Name KV namespaces and buckets in `lyrcloud.json`; they appear on `env`:

```json
{ "kv": { "CACHE": "cache" }, "buckets": { "FILES": "uploads" } }
```

```js
await env.CACHE.put('visits', '1', { expirationTtl: 3600, metadata: { by: 'me' } });
await env.CACHE.get('visits');              // "1"  (or 'json', 'arrayBuffer', 'stream')
await env.CACHE.list({ prefix: 'user:' });  // { keys, list_complete, cursor }

await env.FILES.put('a.txt', 'hello', { httpMetadata: { contentType: 'text/plain' } });
const file = await env.FILES.get('a.txt');  // .text() .json() .arrayBuffer() .body
await env.FILES.list({ prefix: 'notes/' }); // { objects, truncated, cursor }
```

Values can be up to 256 KB and files up to 4 MB. `lyrcloud dev` keeps the data in `.lyrcloud/storage/`. From the terminal: `lyrcloud kv list|get|put|delete <ns>`, `lyrcloud bucket list|put|get|delete <bucket>`, and `lyrcloud storage`.

## AI

Add `"ai": "AI"` to `lyrcloud.json`:

```js
const { response, usage } = await env.AI.run('claude-haiku-4.5', { prompt: 'Hi', max_tokens: 200 });
await env.AI.run('claude-sonnet-4.6', { system, messages }, { cache: 3600, fallback: 'nova-lite' });
const { data } = await env.AI.embed(['text one', 'text two'], { dimensions: 256 });
```

`lyrcloud ai models` lists the models your plan includes, `lyrcloud ai run "prompt"` asks one, and `lyrcloud ai usage` shows this month's tokens. In `lyrcloud dev`, AI calls go to the real gateway on your account.

## Access

Put a function, or some paths, behind Lyrcloud sign-in:

```json
"access": { "allow": ["ada@example.com", "@yourcompany.com"], "paths": ["/admin"] }
```

Visitors sign in at www.lyrcloud.com and only the emails and domains you list (and you) get through. Your code reads `request.headers.get('lyr-access-email')`. `/__lyrcloud/logout` signs out. `lyrcloud access log` shows every decision. In `lyrcloud dev`, protected paths act as if `LYRCLOUD_DEV_EMAIL` (or `dev@localhost`) signed in.

## Security

```json
"security": {
  "rateLimits": [{ "path": "/api", "requests": 100, "per": "1m" }],
  "waf": "block",
  "bots": { "mode": "challenge", "paths": ["/login"] },
  "blockIps": ["203.0.113.0/24"],
  "headers": true
}
```

Rules run before your function: rate limits per visitor IP (`10s`, `1m`, `10m`, `1h`), IP block and allow lists (CIDR), a firewall for common attacks (`"log"` only records), bot checks (`"challenge"` for browsers, `"block"` for automation tools) and secure response headers. `lyrcloud security log` shows what was stopped. `lyrcloud dev` doesn't apply these rules.

## Caching and static sites

Answer with `Cache-Control: public, max-age=300` (or `s-maxage`) and Lyrcloud serves repeat requests from cache; `x-lyr-cache` says HIT, MISS or BYPASS. Private, cookie-setting, signed-in and Access-protected responses are never cached, and each deploy starts fresh. `lyrcloud cache purge [--path /p | --prefix /blog]` clears it.

`"assets": "public"` (or `{ "dir": "public", "spa": true, "maxAge": 3600 }`) serves that folder before your code runs, with content types and ETags. Without `main`, the project is a static site: `lyrcloud init my-site --static`.

## lyrcloud.json

```json
{
  "name": "hello-edge",
  "main": "index.js",
  "vars": { "GREETING": "Hello" },
  "kv": { "CACHE": "cache" },
  "buckets": { "FILES": "uploads" },
  "ai": "AI",
  "access": { "allow": ["@yourcompany.com"], "paths": ["/admin"] },
  "exclude": ["fixtures"]
}
```

`deploy` uploads the project folder plus the packages listed under `dependencies` in `package.json`. It never uploads `node_modules` dev packages, `.git` or `.env`. Uploads can be up to 4 MB zipped.

## Commands

| Command | What it does |
|---|---|
| `lyrcloud login [--email]` | Sign in in the browser (or with email and password) |
| `lyrcloud logout` / `whoami` | Sign out / show who you're signed in as |
| `lyrcloud init <name>` | Create a project in `./<name>` |
| `lyrcloud dev [--port 8787]` | Run locally with the production runtime, reloading on edits |
| `lyrcloud deploy [--name x]` | Deploy and print the address |
| `lyrcloud list` | Your functions |
| `lyrcloud logs [name] [-f] [--since 2h]` | Recent logs; `-f` follows |
| `lyrcloud delete [name] [--yes]` | Take a function offline and free its name |

## .lyr addresses

`.dev.lyr` is part of Lyrcloud's own `.lyr` namespace. It opens on devices that use Lyr DNS and trust the Lyr Root CA. See https://www.lyrcloud.com/lyr/ for setup.

Sign-in is stored in `~/.config/lyrcloud/credentials.json`, readable only by you. Set `LYRCLOUD_API_URL` to use a different API.
