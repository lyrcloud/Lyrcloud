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

## lyrcloud.json

```json
{
  "name": "hello-edge",
  "main": "index.js",
  "vars": { "GREETING": "Hello" },
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
