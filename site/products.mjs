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
    tagline: 'Build and run AI apps on a global network.',
    summary: 'Run open models on edge GPUs, route requests across providers, and add caching, rate limits, and observability to every AI call.',
    features: [
      ['Edge inference', 'Serve popular open models for text, embeddings, and images from GPUs near users.'],
      ['AI gateway', 'One endpoint for multiple model providers with fallbacks and retries.'],
      ['Prompt caching', 'Cache identical requests at the edge to cut latency and spend.'],
      ['Vector search', 'Store embeddings and run similarity search beside your functions.'],
      ['Usage analytics', 'Tokens, cost, and latency per model, per app, per user.'],
      ['Guardrails', 'Filter prompts and responses with configurable safety policies.'],
    ],
    code: `const answer = await env.AI.run('text-model', {
  messages: [{ role: 'user', content: 'Summarize this page' }],
});
return Response.json(answer);`,
  },
  {
    slug: 'storage',
    icon: '▣',
    name: 'Storage & Databases',
    group: 'Developer platform',
    tagline: 'Data that lives where your users are.',
    summary: 'S3-compatible object storage with zero egress fees, a serverless SQL database, and globally replicated key-value storage.',
    features: [
      ['Object storage', 'S3-compatible buckets with no egress fees and automatic edge caching.'],
      ['Serverless SQL', 'SQLite-compatible databases with read replicas close to every user.'],
      ['Key-value store', 'Eventually consistent global KV for config, sessions, and feature flags.'],
      ['Time travel', 'Point-in-time restore for databases up to 30 days back.'],
      ['Event notifications', 'Trigger functions or queues when objects are created or deleted.'],
      ['Migration tooling', 'Incrementally copy data from other clouds with no downtime.'],
    ],
    code: `# Create a bucket and upload a file
lyrcloud storage bucket create assets
lyrcloud storage put assets/logo.svg ./logo.svg

# Query a serverless SQL database
lyrcloud db execute app-db "SELECT count(*) FROM users"`,
  },
];
