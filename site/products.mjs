// Product catalog. Each entry renders /products/<slug>/ and appears in the nav mega-menu.
export const products = [
  {
    slug: 'cdn',
    icon: '⚡',
    name: 'Global CDN',
    group: 'Application performance',
    tagline: 'Cache everything, everywhere, in milliseconds.',
    summary: 'Serve static and dynamic content from a global edge network with tiered caching, smart routing, and instant purges.',
    features: [
      ['Tiered cache', 'Upper-tier data centers shield your origin so cache misses rarely leave the network.'],
      ['Instant purge', 'Purge by URL, tag, prefix, or everything — propagated worldwide in under 150 ms.'],
      ['Smart routing', 'Real-time latency telemetry steers traffic around congested internet paths.'],
      ['Image optimization', 'Resize, compress, and convert to AVIF/WebP on the fly at the edge.'],
      ['HTTP/3 & 0-RTT', 'Modern protocols enabled by default for faster handshakes on every device.'],
      ['Cache rules', 'Fine-grained TTLs, bypass rules, and custom cache keys per hostname or path.'],
    ],
    code: `# Purge a single URL from every edge location
lyrcloud cache purge https://www.example.com/app.js

# Purge everything tagged "product-42"
lyrcloud cache purge --tag product-42`,
  },
  {
    slug: 'security',
    icon: '🛡',
    name: 'Application Security',
    group: 'Application security',
    tagline: 'Stop attacks before they reach your origin.',
    summary: 'Unmetered DDoS mitigation, a managed WAF, bot management, and API protection in one policy engine.',
    features: [
      ['DDoS protection', 'Always-on, unmetered mitigation for L3/4 and L7 attacks of any size.'],
      ['Managed WAF', 'OWASP and zero-day rulesets curated by the Lyrcloud threat team, updated continuously.'],
      ['Bot management', 'Behavioral and fingerprint signals separate good bots from scrapers and credential stuffers.'],
      ['Rate limiting', 'Protect login, checkout, and API endpoints with per-path request budgets.'],
      ['API shield', 'Schema validation, mTLS, and anomaly detection for every API endpoint you expose.'],
      ['Managed TLS', 'Free certificates issued and renewed automatically for every hostname.'],
    ],
    code: `# Block a country and challenge suspicious bots
lyrcloud waf rule create \\
  --expression 'ip.geo.country eq "XX" or bot.score lt 30' \\
  --action challenge`,
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
    icon: '🔐',
    name: 'Zero Trust Access',
    group: 'Network & access',
    tagline: 'Replace your VPN with identity-aware access.',
    summary: 'Protect internal apps, SSH, and private networks with per-request identity and device checks.',
    features: [
      ['Access policies', 'Allow by identity provider group, device posture, location, or time of day.'],
      ['Secure web gateway', 'Filter DNS and HTTP traffic for every employee, on any network.'],
      ['Private tunnels', 'Outbound-only connectors expose internal services without opening firewall ports.'],
      ['Browser isolation', 'Render risky sites remotely so malicious code never touches the device.'],
      ['Device posture', 'Require disk encryption, OS versions, or managed devices before granting access.'],
      ['Audit logs', 'Every access decision logged and exportable to your SIEM.'],
    ],
    code: `# Expose an internal dashboard without opening ports
lyrcloud tunnel create internal-grafana
lyrcloud tunnel route internal-grafana grafana.corp.example.com
lyrcloud access policy add grafana.corp.example.com --allow group:sre`,
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
