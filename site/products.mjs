// Product catalog. Each entry renders /products/<slug>/ and appears in the nav mega-menu; an entry with its own
// `href` (Domains, which has a full page at /domains/) links there instead of getting a product page.
export const productHref = (product) => product.href || `/products/${product.slug}/`;

export const products = [
  {
    slug: 'domains',
    href: '/domains/',
    icon: '🌐',
    name: 'Domains',
    group: 'Domains & DNS',
    tagline: 'Search, register and transfer, with free WHOIS privacy.',
    summary: 'Register or transfer a domain with free WHOIS privacy and Lyrcloud DNS, paid by card or with Lyrpay.',
  },
  {
    slug: 'cdn',
    icon: '⚡',
    name: 'Global CDN',
    group: 'Application services',
    tagline: 'Cache answers. Serve files. Purge in one command.',
    summary: 'Response caching, static files and whole static sites for your edge functions, with cache headers you control and purges from the CLI.',
    features: [
      ['Response caching', 'Answer with <code>Cache-Control: public, max-age=60</code> and repeat requests are served from cache without running your code.'],
      ['Static files & sites', '<code>"assets": "public"</code> serves a folder with content types, ETags and clean URLs. A project can be just a static site.'],
      ['Single-page apps', 'Set <code>"spa": true</code> and unknown routes get <code>index.html</code>.'],
      ['Purge from the CLI', '<code>lyrcloud cache purge</code> clears everything, one path or a prefix. Every deploy starts with a fresh cache.'],
      ['Safe by default', 'Private, cookie-setting, signed-in and Access-protected responses are never cached. <code>x-lyr-cache</code> shows HIT, MISS or BYPASS.'],
      ['Image optimization & edge locations', 'Coming soon.'],
    ],
    code: `// lyrcloud.json: "assets": "public"
export default {
  async fetch(request) {
    const data = await expensiveLookup();
    return Response.json(data, {
      headers: { 'cache-control': 'public, max-age=300' },
    });
  },
};

// $ lyrcloud cache purge --prefix /blog`,
  },
  {
    slug: 'security',
    icon: '🔒',
    name: 'Application Security',
    group: 'Security',
    tagline: 'Stop attacks before they reach your code.',
    summary: 'Rate limits, IP rules, a firewall for common attacks, bot checks and secure headers for your edge functions, set in lyrcloud.json and enforced before your code runs.',
    features: [
      ['Rate limiting', 'Requests per visitor per path, per 10 s, 1 m, 10 m or 1 h. Over the limit gets 429 with <code>Retry-After</code>.'],
      ['Firewall (WAF)', 'Blocks SQL injection, XSS, path traversal, Log4Shell, command injection and probes for secret files. Start in <code>"log"</code> mode to see what it would catch.'],
      ['Bot checks', '<code>"challenge"</code> asks browsers for a quick proof of work that scripts can’t do. <code>"block"</code> refuses automation tools outright.'],
      ['IP rules', 'Block addresses or ranges, or allow only your own, with CIDR for IPv4 and IPv6.'],
      ['Secure headers & TLS', 'HSTS, nosniff, frame and referrer policies added for you; every address gets HTTPS automatically.'],
      ['Security log', '<code>lyrcloud security log</code> shows what was blocked or logged, by rule, path and IP. Country rules are coming soon.'],
    ],
    code: `// lyrcloud.json
"security": {
  "rateLimits": [{ "path": "/api", "requests": 100, "per": "1m" }],
  "waf": "block",
  "bots": { "mode": "challenge", "paths": ["/login"] },
  "blockIps": ["203.0.113.0/24"],
  "headers": true
}`,
  },
  {
    slug: 'edge-functions',
    icon: '{}',
    name: 'Edge Functions',
    group: 'Developer platform',
    tagline: 'Write a fetch handler. Live in seconds.',
    summary: 'Deploy JavaScript fetch handlers from the lyrcloud CLI. Each function runs in its own isolated sandbox and goes live at https://<name>.dev.lyr.',
    features: [
      ['Deploys in seconds', '<code>lyrcloud deploy</code> uploads your project and it’s live in about five seconds.'],
      ['Standard Web APIs', 'Request, Response, URL and fetch: the same code runs in <code>lyrcloud dev</code>, the playground and production.'],
      ['Isolated by design', 'Every function runs in its own sandbox with no access to any other customer’s code or data.'],
      ['Variables', 'Put settings under <code>vars</code> in <code>lyrcloud.json</code> and read them from <code>env</code>.'],
      ['Live logs', 'Anything you <code>console.log</code> shows up in <code>lyrcloud logs -f</code>.'],
      ['Local dev', '<code>lyrcloud dev</code> runs the production runtime on your machine and reloads on every save.'],
    ],
    code: `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/time') {
      return Response.json({ now: new Date() });
    }
    return new Response(\`Hi from \${url.hostname}\`);
  },
};`,
  },
  {
    slug: 'zero-trust',
    icon: '🛡',
    name: 'Zero Trust Access',
    group: 'Security',
    tagline: 'Only the right people get in.',
    summary: 'Put any edge function, or just some of its paths, behind Lyrcloud sign-in with an allow-list of emails and domains. Every decision is logged.',
    features: [
      ['Allow-lists', 'Allow exact emails or whole domains such as <code>@yourcompany.com</code>. You, the owner, always get in.'],
      ['Protect some paths or all', 'Lock <code>/admin</code> and leave the rest public, or protect the whole function.'],
      ['Checked before your code runs', 'Requests without a valid session never reach your function. Forged identity headers are removed.'],
      ['Identity in your code', 'Your function reads the signed-in email from the <code>lyr-access-email</code> header.'],
      ['Audit log', '<code>lyrcloud access log</code> shows every sign-in, allowed or refused, with time, path and IP. Kept 90 days.'],
      ['Device posture & tunnels', 'Coming soon.'],
    ],
    code: `// lyrcloud.json
{
  "name": "team-dashboard",
  "main": "index.js",
  "access": {
    "allow": ["ada@example.com", "@yourcompany.com"],
    "paths": ["/admin"]
  }
}`,
  },
  {
    slug: 'ai',
    icon: '🤖',
    name: 'AI Gateway & Inference',
    group: 'Developer platform',
    tagline: 'Call AI models from your functions with one line.',
    summary: 'env.AI gives your edge functions chat models and embeddings, with fallbacks, response caching, per-plan limits and usage by model. Models run on Amazon Bedrock.',
    features: [
      ['One line to a model', '<code>env.AI.run(model, { prompt })</code> or a full conversation with <code>messages</code> and <code>system</code>.'],
      ['Fallbacks', 'Pass <code>{ fallback: \'nova-lite\' }</code> and the gateway tries the next model when one is busy or unavailable.'],
      ['Response caching', 'Pass <code>{ cache: 3600 }</code> and identical requests are answered from cache, free and in milliseconds.'],
      ['Embeddings', '<code>env.AI.embed(texts)</code> returns Titan vectors in 256, 512 or 1024 dimensions.'],
      ['Usage by model', '<code>lyrcloud ai usage</code> shows requests and tokens per model, against your plan’s monthly budget.'],
      ['Guardrails & vector search', 'Coming soon.'],
    ],
    code: `// lyrcloud.json: "ai": "AI"
export default {
  async fetch(request, env) {
    const { response } = await env.AI.run('claude-haiku-4.5', {
      prompt: 'Summarize edge computing in one line.',
      max_tokens: 100,
    }, { cache: 3600, fallback: 'nova-lite' });
    return new Response(response);
  },
};`,
  },
  {
    slug: 'storage',
    icon: '▣',
    name: 'Storage & Databases',
    group: 'Developer platform',
    tagline: 'Keys and files, right beside your code.',
    summary: 'Key-value namespaces and file buckets your edge functions use through env, managed from the lyrcloud CLI. Each account’s data is kept apart.',
    features: [
      ['Key-value store', '<code>env.CACHE.get/put/list/delete</code> for config, sessions and counters, with optional expiry and metadata.'],
      ['File buckets', '<code>env.FILES.put/get/list/delete</code> for uploads and assets, up to 4 MB per file, with content types kept.'],
      ['From the CLI', '<code>lyrcloud kv</code> and <code>lyrcloud bucket</code> read, write and list your data without writing code.'],
      ['Works offline', '<code>lyrcloud dev</code> keeps the same data in <code>.lyrcloud/</code> in your project, so local and live code match.'],
      ['Private by default', 'Each function gets a signed token that only opens its owner’s data. Files are encrypted at rest.'],
      ['Serverless SQL', 'Coming soon: SQL databases for your functions.'],
    ],
    code: `// lyrcloud.json: "kv": { "CACHE": "cache" }, "buckets": { "FILES": "uploads" }
export default {
  async fetch(request, env) {
    const visits = Number(await env.CACHE.get('visits') ?? 0) + 1;
    await env.CACHE.put('visits', String(visits));
    const logo = await env.FILES.get('logo.svg');
    return new Response(\`Visit #\${visits}\`);
  },
};`,
  },
];
