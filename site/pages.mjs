import { existsSync } from 'node:fs';
import { logo } from '../src/logo.js';
import { escape } from './layout.mjs';
import { products } from './products.mjs';

const pageHero = ({ eyebrow, title, lede, ctas = '' }) => `
      <section class="page-hero section">
        <span class="eyebrow">${eyebrow}</span>
        <h1>${title}</h1>
        <p class="hero-lede">${lede}</p>
        ${ctas ? `<div class="cta-row">${ctas}</div>` : ''}
      </section>`;

const ctaBand = (title = 'Start building on Lyrcloud today.', text = 'Create a free account in under a minute. No credit card required.') => `
      <section class="final-cta glass-card">
        <span class="cta-icon" aria-hidden="true">◎</span>
        <h2>${title}</h2>
        <p>${text}</p>
        <div class="cta-row center">
          <a class="button primary large" href="/sign-up/">Start building for free</a>
          <a class="button secondary large" href="/contact/">Contact sales</a>
        </div>
      </section>`;

const productCard = (product) => `
          <article class="feature-card">
            <span class="feature-icon">${product.icon}</span>
            <h3>${product.name}</h3>
            <p>${escape(product.summary)}</p>
            <a href="/products/${product.slug}/">Learn more <span aria-hidden="true">→</span></a>
          </article>`;

const plans = [
  {
    name: 'Launch',
    price: '$0',
    period: '/month',
    blurb: 'For prototypes, personal sites, and early product launches.',
    items: ['Global CDN', 'Managed TLS', 'Unmetered DDoS protection', '100k edge function requests/day', 'Community support'],
    cta: ['/sign-up/?plan=launch', 'Start for free'],
  },
  {
    name: 'Scale',
    price: '$29',
    period: '/month',
    blurb: 'For growing businesses that need deeper observability and controls.',
    items: ['Everything in Launch', 'Managed WAF rulesets', 'Image optimization', '10M edge function requests/month', 'Priority support'],
    cta: ['/sign-up/?plan=scale', 'Choose Scale'],
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    blurb: 'For mission-critical platforms with compliance and dedicated success needs.',
    items: ['Everything in Scale', 'Private edge networking', '100% uptime SLA', 'Bot management', 'Dedicated onboarding'],
    cta: ['/contact/', 'Contact sales'],
  },
];

const pricingCards = () => `
        <div class="pricing-grid">${plans
          .map(
            (plan) => `
          <article class="price-card${plan.highlighted ? ' highlighted' : ''}">
            ${plan.highlighted ? '<span class="badge">Most popular</span>' : ''}
            <h3>${plan.name}</h3>
            <p>${plan.blurb}</p>
            <div class="price"><strong>${plan.price}</strong>${plan.period ? `<span>${plan.period}</span>` : ''}</div>
            <ul>
              ${plan.items.map((item) => `<li>✓ ${item}</li>`).join('\n              ')}
            </ul>
            <a class="button ${plan.highlighted ? 'primary' : 'secondary'}" href="${plan.cta[0]}">${plan.cta[1]}</a>
          </article>`,
          )
          .join('')}
        </div>`;

// ---------------------------------------------------------------- Home

const home = {
  route: '/',
  title: 'Lyrcloud | Build, secure, and scale at the edge',
  description: 'Lyrcloud is a modern edge cloud platform for fast, secure apps, AI workflows, and global teams.',
  body: `
    <main>
      <section id="top" class="hero section-grid">
        <div class="hero-copy">
          <a class="eyebrow announce" href="/developers/"><span class="announce-tag">New</span> Edge Functions and the <code>lyrcloud</code> CLI <span aria-hidden="true">→</span></a>
          <h1>Build, secure, and scale on <span class="text-gradient">one cloud</span>.</h1>
          <p class="hero-lede">Lyrcloud brings application delivery, edge compute, Zero Trust access, and AI workflow hosting into a single, elegant control plane for modern teams.</p>
          <div class="cta-row">
            <a class="button primary large" href="/sign-up/">Start building for free <span aria-hidden="true">→</span></a>
            <a class="button secondary large" href="/products/">Explore products</a>
          </div>
          <div class="install-pill">
            <code><span aria-hidden="true">$</span> npm install -g lyrcloud</code>
            <button type="button" class="copy-button" data-copy="npm install -g lyrcloud" aria-label="Copy the install command"><span class="copy-label">Copy</span></button>
          </div>
        </div>
        <div class="hero-visual">
          <div class="orbit orbit-one" aria-hidden="true"></div>
          <div class="orbit orbit-two" aria-hidden="true"></div>
          <div class="map-card glass-card">
            <div class="map-header">
              <span>Edge network demo</span>
              <strong>Click the globe</strong>
            </div>
            <div class="globe" role="button" tabindex="0" aria-label="Send a demo request to the nearest edge node">
              <span class="node node-a"></span>
              <span class="node node-b"></span>
              <span class="node node-c"></span>
              <span class="node node-d"></span>
              <span class="path path-one"></span>
              <span class="path path-two"></span>
            </div>
            <div class="traffic-grid" aria-live="polite">
              <div><b data-demo="requests">0</b><span>requests sent</span></div>
              <div><b data-demo="latency">—</b><span>avg. response</span></div>
              <div><b data-demo="blocked">0</b><span>bots challenged</span></div>
            </div>
            <ul class="demo-log" aria-label="Demo request log"></ul>
          </div>
        </div>
      </section>

      <section class="metrics" aria-label="Lyrcloud platform metrics">
        <div class="metric"><strong data-count="99.99" data-suffix="%">99.99%</strong><span>availability target</span></div>
        <div class="metric"><strong data-count="5" data-prefix="~" data-suffix=" s">~5 s</strong><span>from <code>lyrcloud deploy</code> to live</span></div>
        <div class="metric"><strong data-count="0">0</strong><span>dependencies in the CLI</span></div>
        <div class="metric"><strong>24/7</strong><span>threat monitoring</span></div>
      </section>

      <section id="products" class="section">
        <div class="section-heading">
          <span class="eyebrow">One platform</span>
          <h2>Everything your apps need to stay fast, reliable, and protected.</h2>
          <p>Ship code, connect teams, and defend traffic through composable Lyrcloud services that work together by default.</p>
        </div>
        <div class="card-grid three">${products.map(productCard).join('')}
        </div>
      </section>


      <section id="try" class="section playground-section">
        <div class="section-heading">
          <span class="eyebrow">Try it now</span>
          <h2>Write an edge function. Run it right here.</h2>
          <p>Edit the code and press Run. It runs in a sandbox in your browser using the same <code class="inline">fetch(request, env)</code> shape as a deployed function.</p>
        </div>
        <div class="playground glass-card">
          <div class="pg-tabs" role="tablist" aria-label="Examples">
            <button type="button" role="tab" data-preset="hello" aria-selected="true">Hello</button>
            <button type="button" role="tab" data-preset="json" aria-selected="false">JSON API</button>
            <button type="button" role="tab" data-preset="redirect" aria-selected="false">Redirects</button>
            <button type="button" role="tab" data-preset="headers" aria-selected="false">Request info</button>
          </div>
          <div class="pg-body">
            <div class="pg-editor">
              <label class="visually-hidden" for="pg-code">Function code</label>
              <textarea id="pg-code" spellcheck="false" autocapitalize="off" autocomplete="off">${escape(`export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return new Response(\`\${env.GREETING} from \${url.hostname}!\`);
  },
};`)}</textarea>
            </div>
            <div class="pg-result">
              <div class="pg-request">
                <label class="visually-hidden" for="pg-method">Method</label>
                <select id="pg-method"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
                <span class="pg-host">hello-edge.dev.lyr</span>
                <label class="visually-hidden" for="pg-path">Path</label>
                <input id="pg-path" value="/" spellcheck="false" autocomplete="off" />
                <button type="button" class="button primary pg-run">Run <span aria-hidden="true">▶</span></button>
              </div>
              <div class="pg-response" aria-live="polite">
                <div class="pg-response-head"><span class="pg-status">Ready</span><span class="pg-meta">Ctrl + Enter runs it</span></div>
                <pre class="pg-output">Press Run to call your function.</pre>
              </div>
            </div>
          </div>
          <div class="pg-foot">
            <span>Happy with it? Deploy it for real:</span>
            <code>npm install -g lyrcloud &amp;&amp; lyrcloud deploy</code>
            <a class="text-link" href="/developers/#quickstart">Quickstart →</a>
          </div>
        </div>
      </section>

      <section class="workflow section-grid reverse">
        <div class="terminal-card glass-card">
          <div class="terminal-bar"><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span><button type="button" class="terminal-replay" aria-label="Replay the terminal">↻ Replay</button></div>
          <code class="typed" data-typed='[{"kind": "cmd", "text": "$ npm install -g lyrcloud"}, {"kind": "dim", "text": "added 1 package in 0.7s"}, {"kind": "gap", "text": ""}, {"kind": "cmd", "text": "$ lyrcloud init hello-edge"}, {"kind": "ok", "text": "✓ Created hello-edge in ./hello-edge"}, {"kind": "gap", "text": ""}, {"kind": "cmd", "text": "$ cd hello-edge && lyrcloud deploy"}, {"kind": "dim", "text": "Uploading 4 files (1.2 KB, 1.0 KB zipped)…"}, {"kind": "ok", "text": "✓ Deployed hello-edge in 4.2s"}, {"kind": "url", "text": "  https://hello-edge.dev.lyr"}]'>
            <span class="cmd">$ npm install -g lyrcloud</span>
            <span class="dim">added 1 package in 0.7s</span>
            <span class="gap"></span>
            <span class="cmd">$ lyrcloud init hello-edge</span>
            <span class="ok">✓ Created hello-edge in ./hello-edge</span>
            <span class="gap"></span>
            <span class="cmd">$ cd hello-edge && lyrcloud deploy</span>
            <span class="dim">Uploading 4 files (1.2 KB, 1.0 KB zipped)…</span>
            <span class="ok">✓ Deployed hello-edge in 4.2s</span>
            <span class="url">  https://hello-edge.dev.lyr</span>
          </code>
        </div>
        <div>
          <span class="eyebrow">Developer first</span>
          <h2>Deploy globally without rebuilding your stack.</h2>
          <p>Install the CLI, run your function locally with <code class="inline">lyrcloud dev</code>, and deploy in seconds. Lyrcloud handles the routing, certificates and logs.</p>
          <div class="pill-grid">
            <a class="pillar" href="/products/cdn/">☍ Network & CDN</a>
            <a class="pillar" href="/products/edge-functions/">{} Edge Functions</a>
            <a class="pillar" href="/products/ai/">🤖 AI Inference</a>
            <a class="pillar" href="/products/storage/">▣ Data & Storage</a>
          </div>
          <div class="cta-row"><a class="button secondary" href="/developers/">Read the developer docs →</a></div>
        </div>
      </section>

      <section class="section pricing-section">
        <div class="section-heading compact">
          <span class="eyebrow">Simple pricing</span>
          <h2>Start free. Scale when traffic grows.</h2>
        </div>
        ${pricingCards()}
        <p class="center-text"><a class="text-link" href="/pricing/">Compare all plan features →</a></p>
      </section>
${ctaBand('Make your site feel instant everywhere.', 'Launch an edge-ready experience with security, performance, and AI infrastructure built in from the first request.')}
    </main>`,
  scripts: ['/src/home.js'],
};

// ---------------------------------------------------------------- Products

const productsIndex = {
  route: '/products/',
  title: 'Products',
  description: 'Explore the Lyrcloud platform: CDN, application security, edge functions, Zero Trust, AI, and storage.',
  body: `
    <main>
${pageHero({
  eyebrow: 'The Lyrcloud platform',
  title: 'One network. Every service your apps need.',
  lede: 'Lyrcloud products are built to work together, so performance, security, and compute share one control plane instead of fighting over a request.',
  ctas: '<a class="button primary large" href="/sign-up/">Start building</a><a class="button secondary large" href="/pricing/">See pricing</a>',
})}
      ${[...new Set(products.map((product) => product.group))]
        .map(
          (group) => `
      <section class="section product-group">
        <h2 class="group-title">${group}</h2>
        <div class="card-grid three">${products.filter((product) => product.group === group).map(productCard).join('')}
        </div>
      </section>`,
        )
        .join('')}
${ctaBand()}
    </main>`,
};

const productPages = products.map((product) => ({
  route: `/products/${product.slug}/`,
  title: product.name,
  description: product.summary,
  body: `
    <main>
      <section class="hero section-grid product-hero">
        <div>
          <a class="eyebrow" href="/products/">${product.group}</a>
          <h1 class="product-title">${product.tagline}</h1>
          <p class="hero-lede">${escape(product.summary)}</p>
          <div class="cta-row">
            <a class="button primary large" href="/sign-up/?product=${product.slug}">Get started free</a>
            <a class="button secondary large" href="/contact/">Talk to an expert</a>
          </div>
        </div>
        <div class="terminal-card glass-card">
          <div class="terminal-bar" aria-hidden="true"><span></span><span></span><span></span></div>
          <pre><code>${escape(product.code)}</code></pre>
        </div>
      </section>

      <section class="section">
        <div class="section-heading compact">
          <span class="eyebrow">${product.icon} ${product.name}</span>
          <h2>What you get</h2>
        </div>
        <div class="card-grid three">${product.features
          .map(
            ([name, text]) => `
          <article class="feature-card compact">
            <h3>${name}</h3>
            <p>${text}</p>
          </article>`,
          )
          .join('')}
        </div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Works with the rest of Lyrcloud</h2></div>
        <div class="card-grid three">${products.filter((other) => other.slug !== product.slug).slice(0, 3).map(productCard).join('')}
        </div>
      </section>
${ctaBand(`Try ${product.name} free.`)}
    </main>`,
}));

// ---------------------------------------------------------------- Solutions

const solutions = [
  ['🛒', 'E-commerce', 'Keep checkout fast on peak days, stop card-testing bots, and personalize storefronts at the edge.', ['cdn', 'security', 'edge-functions']],
  ['🧩', 'SaaS platforms', 'Offer custom domains with automatic TLS for every customer and run tenant logic close to users.', ['security', 'edge-functions', 'storage']],
  ['🎬', 'Media & streaming', 'Deliver video and large files with zero egress fees and cache hit ratios above 95%.', ['cdn', 'storage']],
  ['🏛', 'Public sector', 'Protect citizen services from DDoS and give staff secure access without legacy VPNs.', ['security', 'zero-trust']],
  ['🎮', 'Gaming', 'Low-latency APIs, matchmaking state at the edge, and protection against volumetric attacks.', ['edge-functions', 'security']],
  ['🚀', 'Startups', 'Launch on the free plan, add AI features in an afternoon, and scale without re-architecting.', ['ai', 'edge-functions', 'storage']],
];

const solutionsPage = {
  route: '/solutions/',
  title: 'Solutions',
  description: 'How teams in e-commerce, SaaS, media, the public sector, gaming, and startups use Lyrcloud.',
  body: `
    <main>
${pageHero({
  eyebrow: 'Solutions',
  title: 'Built for the way your industry ships.',
  lede: 'Whether you run a storefront, a multi-tenant SaaS, or critical public services, Lyrcloud adapts to your traffic, threats, and teams.',
})}
      <section class="section">
        <div class="card-grid three">${solutions
          .map(
            ([icon, name, text, used]) => `
          <article class="feature-card">
            <span class="feature-icon">${icon}</span>
            <h3>${name}</h3>
            <p>${text}</p>
            <div class="tag-row">${used
              .map((slug) => products.find((product) => product.slug === slug))
              .map((product) => `<a class="tag" href="/products/${product.slug}/">${product.name}</a>`)
              .join('')}</div>
          </article>`,
          )
          .join('')}
        </div>
      </section>
${ctaBand('Not sure where to start?', 'Our solutions engineers will map your architecture to the right Lyrcloud services.')}
    </main>`,
};

// ---------------------------------------------------------------- Developers

const cliCommands = [
  ['lyrcloud login', 'Sign in with your Lyrcloud account in the browser (<code>--email</code> for email and password).'],
  ['lyrcloud init <name>', 'Create a new edge function project in <code>./&lt;name&gt;</code>.'],
  ['lyrcloud dev', 'Run the project on <code>localhost:8787</code> with the same runtime as production, reloading on every edit.'],
  ['lyrcloud deploy', 'Upload the project and make it live at <code>https://&lt;name&gt;.dev.lyr</code>.'],
  ['lyrcloud list', 'List your functions, their status and addresses.'],
  ['lyrcloud logs [name] [-f]', 'Show recent logs; <code>-f</code> keeps following, <code>--since 2h</code> looks further back.'],
  ['lyrcloud delete [name]', 'Take a function offline and free its name.'],
  ['lyrcloud whoami / logout', 'Show who you’re signed in as, or sign out on this computer.'],
  ['lyrcloud kv list|get|put|delete <ns>', 'Read and write a KV namespace your functions use.'],
  ['lyrcloud bucket list|put|get|delete <bucket>', 'Upload, download and list files in a bucket.'],
  ['lyrcloud storage', 'List the namespaces and buckets your functions bind.'],
  ['lyrcloud ai models | run | usage', 'See the models on your plan, ask one from the terminal, and check this month’s tokens.'],
  ['lyrcloud access log [name]', 'See who signed in to a protected function, allowed or refused.'],
  ['lyrcloud security log [name]', 'See which requests your security rules blocked or logged.'],
];

const developersPage = {
  route: '/developers/',
  title: 'Developers',
  description: 'Lyrcloud developer hub: quickstart, CLI reference, and examples for edge functions, storage, and AI.',
  body: `
    <main>
${pageHero({
  eyebrow: 'Developer hub',
  title: 'From <code class="inline">git push</code> to global in seconds.',
  lede: 'Everything you need to build on Lyrcloud: a CLI, local dev runtime, framework adapters, and APIs for every product.',
  ctas: '<a class="button primary large" href="#quickstart">Quickstart</a><a class="button secondary large" href="/dash/#/workers">Open the dashboard</a>',
})}
      <section id="quickstart" class="section">
        <div class="section-heading compact">
          <span class="eyebrow">Quickstart</span>
          <h2>Deploy your first edge function</h2>
        </div>
        <ol class="steps">
          <li>
            <h3>Install the CLI</h3>
            <pre class="snippet"><code>npm install -g lyrcloud</code></pre>
          </li>
          <li>
            <h3>Create a project</h3>
            <pre class="snippet"><code>lyrcloud init hello-edge
cd hello-edge</code></pre>
          </li>
          <li>
            <h3>Write your handler</h3>
            <pre class="snippet"><code>${escape(`export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return new Response(env.GREETING + ' from ' + url.hostname);
  },
};`)}</code></pre>
            <p>Try it locally with <code class="inline">lyrcloud dev</code>. <code class="inline">env</code> holds the <code class="inline">vars</code> in <code class="inline">lyrcloud.json</code>.</p>
          </li>
          <li>
            <h3>Deploy</h3>
            <pre class="snippet"><code>lyrcloud login
lyrcloud deploy
✓ Deployed hello-edge in 4.2s
  https://hello-edge.dev.lyr</code></pre>
            <p><code class="inline">.dev.lyr</code> addresses open on devices set up for <a href="/lyr/">Lyr DNS</a>.</p>
          </li>
        </ol>
      </section>

      <section id="storage" class="section">
        <div class="section-heading compact">
          <span class="eyebrow">Storage</span>
          <h2>Keys and files in your functions</h2>
          <p>Name a KV namespace or a bucket in <code class="inline">lyrcloud.json</code>, and it appears on <code class="inline">env</code>. <code class="inline">lyrcloud dev</code> keeps the data in <code class="inline">.lyrcloud/</code> while you work.</p>
        </div>
        <div class="section-grid">
          <pre class="snippet"><code>${escape(`{
  "name": "hello-edge",
  "main": "index.js",
  "kv": { "CACHE": "cache" },
  "buckets": { "FILES": "uploads" }
}`)}</code></pre>
          <pre class="snippet"><code>${escape(`const n = Number(await env.CACHE.get('visits') ?? 0) + 1;
await env.CACHE.put('visits', String(n), { expirationTtl: 86400 });

await env.FILES.put('notes/a.txt', 'hello');
const file = await env.FILES.get('notes/a.txt');
return new Response(file.body, {
  headers: { 'content-type': file.httpMetadata.contentType },
});`)}</code></pre>
        </div>
      </section>

      <section id="ai" class="section">
        <div class="section-heading compact">
          <span class="eyebrow">AI</span>
          <h2>AI models in your functions</h2>
          <p>Add <code class="inline">"ai": "AI"</code> to <code class="inline">lyrcloud.json</code>. Run <code class="inline">lyrcloud ai models</code> to see what your plan includes.</p>
        </div>
        <pre class="snippet"><code>${escape(`const answer = await env.AI.run('claude-sonnet-4.6', {
  system: 'You are a helpful support agent.',
  messages: [{ role: 'user', content: 'Where is my order?' }],
  max_tokens: 300,
}, { cache: 600, fallback: ['claude-haiku-4.5', 'nova-lite'] });
// { response, usage: { input_tokens, output_tokens }, model, cached }

const { data } = await env.AI.embed(['first text', 'second text']);`)}</code></pre>
      </section>

      <section id="access" class="section">
        <div class="section-heading compact">
          <span class="eyebrow">Access</span>
          <h2>Protect a function with sign-in</h2>
          <p>Add <code class="inline">access</code> to <code class="inline">lyrcloud.json</code>. Visitors sign in with Lyrcloud, and only the emails and domains you list get through. Your code reads who they are from <code class="inline">lyr-access-email</code>.</p>
        </div>
        <div class="section-grid">
          <pre class="snippet"><code>${escape(`"access": {
  "allow": ["ada@example.com", "@yourcompany.com"],
  "paths": ["/admin"]
}`)}</code></pre>
          <pre class="snippet"><code>${escape(`const email = request.headers.get('lyr-access-email');
// "ada@example.com" on /admin, null on public paths

// Send people to /__lyrcloud/logout to sign out.`)}</code></pre>
        </div>
      </section>

      <section id="security" class="section">
        <div class="section-heading compact">
          <span class="eyebrow">Security</span>
          <h2>Rate limits, firewall and bot checks</h2>
          <p>Add <code class="inline">security</code> to <code class="inline">lyrcloud.json</code>. Rules run before your code, and <code class="inline">lyrcloud security log</code> shows what they stopped.</p>
        </div>
        <pre class="snippet"><code>${escape(`"security": {
  "rateLimits": [{ "path": "/api", "requests": 100, "per": "1m" }],
  "waf": "block",
  "bots": { "mode": "challenge", "paths": ["/login"] },
  "blockIps": ["203.0.113.0/24"],
  "headers": true
}`)}</code></pre>
      </section>

      <section id="cli" class="section">
        <div class="section-heading compact">
          <span class="eyebrow">Reference</span>
          <h2>CLI commands</h2>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Command</th><th>Description</th></tr></thead>
            <tbody>
              ${cliCommands.map(([command, text]) => `<tr><td><code>${escape(command)}</code></td><td>${text}</td></tr>`).join('\n              ')}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Product guides</h2></div>
        <div class="card-grid three">${products.map(productCard).join('')}
        </div>
      </section>
${ctaBand('Ready to ship?', 'Create a free account and deploy your first function in under five minutes.')}
    </main>`,
};

// ---------------------------------------------------------------- Network

// [city, longitude, latitude]
const cities = [
  ['Ashburn', -77.5, 39], ['New York', -74, 40.7], ['Chicago', -87.6, 41.9], ['Dallas', -96.8, 32.8], ['Los Angeles', -118.2, 34],
  ['Seattle', -122.3, 47.6], ['Toronto', -79.4, 43.7], ['Miami', -80.2, 25.8], ['Mexico City', -99.1, 19.4], ['São Paulo', -46.6, -23.5],
  ['Buenos Aires', -58.4, -34.6], ['Bogotá', -74.1, 4.7], ['Santiago', -70.7, -33.4], ['London', -0.1, 51.5], ['Paris', 2.3, 48.9],
  ['Frankfurt', 8.7, 50.1], ['Amsterdam', 4.9, 52.4], ['Madrid', -3.7, 40.4], ['Stockholm', 18.1, 59.3], ['Warsaw', 21, 52.2],
  ['Milan', 9.2, 45.5], ['Istanbul', 29, 41], ['Dubai', 55.3, 25.2], ['Johannesburg', 28, -26.2], ['Lagos', 3.4, 6.5],
  ['Nairobi', 36.8, -1.3], ['Cairo', 31.2, 30], ['Mumbai', 72.9, 19.1], ['Delhi', 77.2, 28.6], ['Chennai', 80.3, 13.1],
  ['Singapore', 103.8, 1.35], ['Jakarta', 106.8, -6.2], ['Hong Kong', 114.2, 22.3], ['Tokyo', 139.7, 35.7], ['Seoul', 127, 37.6],
  ['Osaka', 135.5, 34.7], ['Taipei', 121.5, 25], ['Manila', 121, 14.6], ['Sydney', 151.2, -33.9], ['Melbourne', 145, -37.8],
  ['Auckland', 174.8, -36.8], ['Perth', 115.9, -31.9],
];

// How a request is handled, layer by layer.
const layers = [
  ['Global', 'Delivery: sites and assets are cached and served from edge locations worldwide.'],
  ['US East', 'Compute: Edge Functions run in Lyrcloud’s compute region, each in its own sandbox.'],
  ['.lyr', 'DNS: Lyrcloud answers .lyr names from its own DNS-over-HTTPS resolver.'],
  ['Lyr Root CA', 'TLS: .lyr addresses get HTTPS certificates from Lyrcloud’s own root.'],
];

const networkPage = {
  route: '/network/',
  title: 'Global network',
  description: 'How Lyrcloud delivers, runs, and resolves your traffic: global delivery, a compute region for Edge Functions, and its own .lyr DNS.',
  body: `
    <main>
${pageHero({
  eyebrow: 'Global network',
  title: 'One network, four layers.',
  lede: 'Lyrcloud serves content from a global edge network, runs Edge Functions in its compute region, answers .lyr names from its own resolver, and secures them with its own certificate authority.',
})}
      <section class="section">
        <div class="network-map glass-card">
          <svg viewBox="0 0 360 180" role="img" aria-label="Map of cities the delivery network serves content from">
            <defs>
              <pattern id="dots" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.45" fill="currentColor" opacity="0.25" /></pattern>
            </defs>
            <rect width="360" height="180" fill="url(#dots)" />
            ${cities
              .map(([name, lon, lat]) => `<circle class="city" cx="${(lon + 180).toFixed(1)}" cy="${(90 - lat).toFixed(1)}" r="1.8"><title>${name}</title></circle>`)
              .join('\n            ')}
          </svg>
        </div>
        <div class="metrics region-grid">
          ${layers.map(([name, text]) => `<div class="metric"><strong>${name}</strong><span>${text}</span></div>`).join('\n          ')}
        </div>
        <p class="center-text muted-note">Some of the cities the delivery network serves content from.</p>
        <ul class="city-list">
          ${cities.map(([name]) => `<li>${name}</li>`).join('')}
        </ul>
      </section>
${ctaBand()}
    </main>`,
};

// ---------------------------------------------------------------- Pricing

const comparison = [
  ['Global CDN & caching', '✓', '✓', '✓'],
  ['Managed TLS certificates', '✓', '✓', '✓'],
  ['Unmetered DDoS protection', '✓', '✓', '✓'],
  ['Custom domains', '3', 'Unlimited', 'Unlimited'],
  ['Edge function requests', '100k / day', '10M / month', 'Custom'],
  ['Managed WAF rulesets', '—', '✓', '✓'],
  ['Image optimization', '—', '✓', '✓'],
  ['Bot management', '—', 'Basic', 'Advanced'],
  ['Zero Trust seats', '5', '50', 'Unlimited'],
  ['Analytics retention', '24 hours', '30 days', '1 year'],
  ['Uptime SLA', '—', '99.99%', '100%'],
  ['Support', 'Community', 'Priority email', '24/7 phone & dedicated CSM'],
];

const faqs = [
  ['Is the Launch plan really free?', 'Yes. Launch is free forever for personal and hobby projects. You only pay when you upgrade.'],
  ['Do you charge for bandwidth?', 'No. CDN bandwidth and DDoS mitigation are unmetered on every plan.'],
  ['Can I change plans later?', 'Anytime, from the dashboard. Upgrades take effect immediately and are prorated.'],
  ['Do you offer annual billing?', 'Yes — annual billing on Scale saves two months. Enterprise contracts are annual.'],
];

const domainFaqs = [
  ['What’s included with every domain?', 'Free WHOIS privacy, Lyrcloud DNS with a simple record editor, and one-click setup as a Lyrcloud website with CDN, TLS and DDoS protection.'],
  ['How does renewal work?', 'Auto-renew is on by default: we charge the card you paid with 30 days before the domain expires, then renew it. Turn it off any time in the dashboard, or renew early for up to five years.'],
  ['Can I move a domain I already own?', 'Yes. Unlock it at your current registrar, get its transfer (EPP) code and start a transfer in the dashboard. A transfer adds a year to the registration and usually takes 5–7 days. Your site keeps its current DNS while it moves.'],
  ['What if the registry rejects my order?', 'You’re refunded in full, automatically. You only pay for a domain we actually register or transfer for you.'],
  ['Why do you need my address?', 'Registries require the owner’s real contact details. They’re kept private by WHOIS privacy. Look out for a verification email after you buy and click it within 15 days, or the registry suspends the domain.'],
];

const domainsPage = {
  route: '/domains/',
  title: 'Domains',
  description: 'Search, register and transfer domains with free WHOIS privacy and Lyrcloud DNS. Honest prices that stay the same at renewal.',
  scripts: ['/src/domains.js'],
  body: `
    <main>
${pageHero({
  eyebrow: 'Domains',
  title: 'Find the right name for what you’re building.',
  lede: 'Register or transfer a domain with free WHOIS privacy and Lyrcloud DNS. What you pay at renewal is what you see today.',
})}
      <section class="section tight">
        <form class="domain-search glass-card" id="domain-search" role="search">
          <input name="q" id="domain-query" placeholder="Search for a domain, like mybrand.com" aria-label="Domain name" autocomplete="off" required />
          <button class="button primary" type="submit">Search</button>
        </form>
        <p class="domain-status" id="domain-status" role="status" aria-live="polite"></p>
        <div id="domain-results"></div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Prices</h2><p>Per year, in US dollars. WHOIS privacy and DNS included.</p></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Domain</th><th>Register</th><th>Renew</th><th>Transfer in</th></tr></thead>
            <tbody id="domain-prices"><tr><td colspan="4">Loading prices…</td></tr></tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Questions</h2></div>
        <div class="faq">
          ${domainFaqs.map(([question, answer]) => `<details><summary>${question}</summary><p>${answer}</p></details>`).join('\n          ')}
        </div>
      </section>
      <section class="section tight">
        <a class="lyr-teaser glass-card" href="/lyr/"><span class="eyebrow">Preview</span><b>Coming later: .lyr names</b><span>See how Lyrcloud’s own extension works →</span></a>
      </section>
${ctaBand('Already have a domain?', 'Put it on Lyrcloud for a global CDN, free TLS and DDoS protection, wherever it’s registered.')}
    </main>`,
};

// Must match DOMAINS_API_BASE in src/auth.js (and public/lyr.mobileconfig).
const LYR_RESOLVER = 'https://uqp5mc2gq0.execute-api.us-east-1.amazonaws.com/dns-query';

const lyrSetup = [
  ['Chrome, Edge or Brave (computer or Android)', `Open <b>Settings → Privacy and security → Security → Use secure DNS</b>, choose <b>Custom</b> (on Android: <b>Choose another provider → Custom</b>) and paste the address above.`],
  ['Firefox', `Open <b>Settings → Privacy &amp; Security → DNS over HTTPS</b>, choose <b>Max Protection</b>, pick <b>Custom</b> and paste the address above. Then type names with a slash, like <code>shop.lyr/</code>, so Firefox doesn’t search for them.`],
  ['iPhone, iPad or Mac', `<a href="/lyr.mobileconfig">Download the Lyrcloud DNS profile</a>, then install it in <b>Settings → General → VPN, DNS &amp; Device Management</b>. Remove it there any time.`],
];

// HTTPS for .lyr is offered once scripts/lyr-root-ca.mjs has written the root certificate.
const LYR_HTTPS = existsSync(new URL('../public/lyr-root.crt', import.meta.url));

const lyrHttpsSetup = [
  ['Windows', `<a href="/lyr-root.crt">Download the root</a>, open it, choose <b>Install Certificate → Current User → Place all certificates in the following store → Trusted Root Certification Authorities</b>. Chrome and Edge use it straight away.`],
  ['Mac', `The <a href="/lyr.mobileconfig">Lyrcloud DNS profile</a> includes the root. Or <a href="/lyr-root.crt">download it</a>, open it in <b>Keychain Access</b>, double-click <b>Lyrcloud .lyr Root CA</b> and set <b>When using this certificate</b> to <b>Always Trust</b>.`],
  ['iPhone or iPad', `Install the <a href="/lyr.mobileconfig">Lyrcloud DNS profile</a> (it includes the root), then turn it on in <b>Settings → General → About → Certificate Trust Settings</b>.`],
  ['Android', `<a href="/lyr-root.crt">Download the root</a>, then open <b>Settings → Security → More security settings → Install from device storage → CA certificate</b>.`],
  ['Firefox', `Firefox keeps its own list: <b>Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import</b>, pick the root and tick <b>Trust this CA to identify websites</b>.`],
  ['Linux', `<code>sudo cp lyr-root.crt /usr/local/share/ca-certificates/ &amp;&amp; sudo update-ca-certificates</code>`],
];

const lyrPage = {
  route: '/lyr/',
  title: '.lyr preview',
  description: 'A preview of .lyr, Lyrcloud’s own domain extension. See how .lyr names work and try them with Lyrcloud DNS.',
  scripts: ['/src/lyr.js'],
  body: `
    <main>
${pageHero({
  eyebrow: 'Preview',
  title: 'Meet .lyr — names that end in Lyr.',
  lede: 'A preview of Lyrcloud’s own domain extension. .lyr names work today on any device that uses Lyrcloud DNS.',
})}
      <section class="section tight">
        <div class="lyr-callout glass-card">
          <h2>What “preview” means</h2>
          <ul>
            <li><b>.lyr isn’t an official extension yet.</b> It isn’t approved by ICANN, so most devices can’t open .lyr names. They work once a device or browser uses Lyrcloud DNS (below).</li>
            ${LYR_HTTPS
    ? '<li><b>A padlock with one extra step.</b> Public certificate authorities don’t issue certificates for .lyr, so Lyrcloud runs its own. Install the Lyr root (below) and .lyr sites open over <code>https://</code>.</li>'
    : '<li><b>No padlock yet.</b> Public certificate authorities don’t issue certificates for .lyr, so .lyr sites open over plain <code>http://</code> for now.</li>'}
            <li><b>Free while it’s a preview.</b> Claim up to three .lyr names below and point them anywhere from your dashboard; they work on Lyrcloud DNS straight away. You keep first claim if .lyr becomes official.</li>
          </ul>
        </div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Claim your .lyr name</h2><p>Free, no card needed. First come, first served.</p></div>
        <form class="domain-search glass-card" id="lyr-reserve">
          <input name="name" id="lyr-reserve-name" placeholder="mybrand.lyr" aria-label=".lyr name to reserve" autocomplete="off" required />
          <button class="button primary" type="submit">Check</button>
        </form>
        <div class="lyr-result" id="lyr-reserve-result" role="status" aria-live="polite"></div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Look up a .lyr name</h2><p>Asks Lyrcloud DNS directly, so it works on any device.</p></div>
        <form class="domain-search glass-card" id="lyr-lookup">
          <input name="name" id="lyr-name" placeholder="hello.lyr" aria-label=".lyr name" autocomplete="off" required />
          <select name="type" id="lyr-type" aria-label="Record type"><option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>MX</option></select>
          <button class="button primary" type="submit">Look up</button>
        </form>
        <div class="lyr-result" id="lyr-result" role="status" aria-live="polite"></div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Open .lyr names on your device</h2><p>Lyrcloud DNS answers .lyr names and passes every other lookup to a public resolver, so the rest of the web works as usual.</p></div>
        <div class="lyr-resolver glass-card">
          <span>Lyrcloud DNS address</span>
          <code id="lyr-resolver">${LYR_RESOLVER}</code>
          <button class="button ghost" type="button" id="lyr-copy">Copy</button>
        </div>
        <div class="faq">
          ${lyrSetup.map(([device, steps]) => `<details><summary>${device}</summary><p>${steps}</p></details>`).join('\n          ')}
        </div>
      </section>
${LYR_HTTPS ? `
      <section class="section">
        <div class="section-heading compact"><h2>Get the padlock on .lyr sites</h2><p>Install the Lyr root once. It can only vouch for names ending in .lyr: browsers reject anything else it signs, so it can’t be used against any other website.</p></div>
        <div class="faq">
          ${lyrHttpsSetup.map(([device, steps]) => `<details><summary>${device}</summary><p>${steps}</p></details>`).join('\n          ')}
        </div>
        <p class="muted">Running a .lyr site? Get its certificate in <a href="/dash/#/domains">Dashboard → Domains</a>.</p>
      </section>
` : ''}
      <section class="section">
        <div class="section-heading compact"><h2>The road to an official .lyr</h2><p>For .lyr to work on every device with no setup, ICANN has to add it to the root of the internet.</p></div>
        <div class="faq">
          <details><summary>Where things stand</summary><p>ICANN accepts new extensions in application rounds. The 2026 round closed on 12 August 2026 and no date is set for the next one. Until then, .lyr works through Lyrcloud DNS, and everything you set up now carries over.</p></details>
          <details><summary>What happens to my name</summary><p>Names claimed during the preview keep first claim if .lyr becomes official, under whatever rules ICANN sets then.</p></details>
        </div>
      </section>
${ctaBand('Want a name that works everywhere today?', 'Register a .com, .io, .dev and more with free WHOIS privacy and Lyrcloud DNS.')}
    </main>`,
};

const pricingPage = {
  route: '/pricing/',
  title: 'Pricing',
  description: 'Simple, predictable Lyrcloud pricing. Start free and scale when traffic grows.',
  body: `
    <main>
${pageHero({
  eyebrow: 'Pricing',
  title: 'Start free. Scale when traffic grows.',
  lede: 'Unmetered bandwidth and DDoS protection on every plan. No surprise bills.',
})}
      <section class="section pricing-section tight">
        ${pricingCards()}
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Compare plans</h2></div>
        <div class="table-wrap">
          <table class="data-table compare">
            <thead><tr><th>Feature</th>${plans.map((plan) => `<th>${plan.name}</th>`).join('')}</tr></thead>
            <tbody>
              ${comparison.map(([feature, ...values]) => `<tr><td>${feature}</td>${values.map((value) => `<td>${value}</td>`).join('')}</tr>`).join('\n              ')}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-heading compact"><h2>Frequently asked questions</h2></div>
        <div class="faq">
          ${faqs.map(([question, answer]) => `<details><summary>${question}</summary><p>${answer}</p></details>`).join('\n          ')}
        </div>
      </section>
${ctaBand()}
    </main>`,
};

// ---------------------------------------------------------------- Company

const aboutPage = {
  route: '/about/',
  title: 'About',
  description: 'Lyrcloud is on a mission to make the internet faster, safer, and simpler to build on.',
  body: `
    <main>
${pageHero({
  eyebrow: 'About Lyrcloud',
  title: 'Helping build a faster, safer internet.',
  lede: 'We believe every team — from a solo developer to a global enterprise — deserves world-class performance and security without stitching together a dozen vendors.',
})}
      <section class="section">
        <div class="card-grid three">
          <article class="feature-card compact"><h3>Secure by default</h3><p>Protection should not be an add-on. Every plan ships with DDoS mitigation and TLS turned on.</p></article>
          <article class="feature-card compact"><h3>Developer first</h3><p>Great infrastructure gets out of the way. We obsess over the CLI, the docs, and the first five minutes.</p></article>
          <article class="feature-card compact"><h3>One network</h3><p>Every product runs everywhere, so you never trade latency for features.</p></article>
        </div>
      </section>
${ctaBand('Build with us.')}
    </main>`,
};

const contactPage = {
  route: '/contact/',
  title: 'Contact sales',
  description: 'Talk to the Lyrcloud sales team about Enterprise plans, migrations, and custom requirements.',
  scripts: ['/src/contact.js'],
  body: `
    <main>
      <section class="section section-grid contact-grid">
        <div>
          <span class="eyebrow">Contact sales</span>
          <h1 class="product-title">Let’s talk about your traffic.</h1>
          <p class="hero-lede">Tell us about your project and a solutions engineer will get back to you within one business day.</p>
          <ul class="check-list">
            <li>✓ Architecture and migration planning</li>
            <li>✓ Custom SLAs and volume pricing</li>
            <li>✓ Security and compliance reviews</li>
          </ul>
          <p>Prefer email? <a class="text-link" href="mailto:hello@lyrcloud.com">hello@lyrcloud.com</a></p>
        </div>
        <form class="form-card glass-card" id="contact-form">
          <label>Full name<input name="name" required autocomplete="name" /></label>
          <label>Work email<input name="email" type="email" required autocomplete="email" /></label>
          <label>Company<input name="company" autocomplete="organization" /></label>
          <label>Monthly traffic
            <select name="traffic">
              <option>Under 1 TB</option>
              <option>1–50 TB</option>
              <option>50–500 TB</option>
              <option>500 TB+</option>
            </select>
          </label>
          <label>How can we help?<textarea name="message" rows="4" required></textarea></label>
          <button class="button primary large" type="submit">Send message</button>
          <p class="form-note">Opens your email app with the message pre-filled to hello@lyrcloud.com.</p>
        </form>
      </section>
    </main>`,
};

// ---------------------------------------------------------------- Auth

// GitHub sign-in goes through the OIDC bridge (infra/aws/github-bridge.yml, scripts/deploy-github-bridge.sh)
// that the GitHubBridge identity provider points at. Set to false to hide the button.
const GITHUB_SIGN_IN_ENABLED = true;
const githubButton = (isSignUp) => `
            <button class="provider-button" type="button" data-login="github">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/></svg>
              ${isSignUp ? 'Sign up' : 'Continue'} with GitHub
            </button>`;

const passwordHint = 'At least 8 characters, with upper and lower case letters, a number and a symbol.';
const codeInput = '<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456" />';
const formError = '<p class="form-error" role="alert" hidden></p>';

// Every step of email-and-password sign-up, log-in and reset lives on both pages; src/login.js shows
// one at a time. Each form is a step; [data-goto] buttons switch steps.
const authSteps = ({ isSignUp }) => `
        <form class="auth-form" data-step="sign-up"${isSignUp ? '' : ' hidden'}>
          <label>Full name<input name="name" autocomplete="name" maxlength="120" required /></label>
          <label>Email<input name="email" type="email" autocomplete="email" required /></label>
          <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required aria-describedby="password-hint" /></label>
          <p class="form-note" id="password-hint">${passwordHint}</p>
          ${formError}
          <button class="button primary large" type="submit">Create account</button>
          <p class="form-note">We’ll email you a code to confirm your address, plus occasional product updates you can turn off any time.</p>
        </form>
        <form class="auth-form" data-step="sign-in"${isSignUp ? ' hidden' : ''}>
          <label>Email<input name="email" type="email" autocomplete="email" required /></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
          ${formError}
          <button class="button primary large" type="submit">Log in</button>
          <button class="text-button" type="button" data-goto="forgot">Forgot your password?</button>
        </form>
        <form class="auth-form" data-step="confirm" hidden>
          <h2>Check your email</h2>
          <p class="form-note">We sent a 6-digit code to <b data-show="email"></b>. It can take a minute to arrive — check spam too.</p>
          <label>Verification code${codeInput}</label>
          ${formError}
          <button class="button primary large" type="submit">Verify email</button>
          <button class="text-button" type="button" data-action="resend">Send a new code</button>
        </form>
        <form class="auth-form" data-step="forgot" hidden>
          <h2>Reset your password</h2>
          <p class="form-note">Enter your account’s email and we’ll send you a code.</p>
          <label>Email<input name="email" type="email" autocomplete="email" required /></label>
          ${formError}
          <button class="button primary large" type="submit">Send reset code</button>
          <button class="text-button" type="button" data-goto="sign-in">Back to log in</button>
        </form>
        <form class="auth-form" data-step="reset" hidden>
          <h2>Choose a new password</h2>
          <p class="form-note">If <b data-show="email"></b> has an account, a code is on its way.</p>
          <label>Reset code${codeInput}</label>
          <label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>
          <p class="form-note">${passwordHint}</p>
          ${formError}
          <button class="button primary large" type="submit">Set new password</button>
        </form>
        <form class="auth-form" data-step="phone" hidden>
          <h2>Add your mobile number</h2>
          <p class="form-note">We’ll text you a code. Your number helps us keep your account secure and reach you about it.</p>
          <label>Mobile number<input name="phone" type="tel" autocomplete="tel" required placeholder="+91 98765 43210" /></label>
          <p class="form-note">Include your country code.</p>
          ${formError}
          <button class="button primary large" type="submit">Text me a code</button>
          <button class="text-button" type="button" data-action="finish">Skip for now</button>
        </form>
        <form class="auth-form" data-step="phone-code" hidden>
          <h2>Enter the code</h2>
          <p class="form-note">We texted a 6-digit code to <b data-show="phone"></b>.</p>
          <label>Code${codeInput}</label>
          ${formError}
          <button class="button primary large" type="submit">Verify number</button>
          <button class="text-button" type="button" data-goto="phone">Use a different number</button>
          <button class="text-button" type="button" data-action="finish">Skip for now</button>
        </form>`;

const authShell = ({ mode }) => {
  const isSignUp = mode === 'sign-up';
  return `
    <main class="auth-page">
      <a class="brand auth-brand" href="/" aria-label="Lyrcloud home">${logo('auth')}</a>
      <div class="form-card glass-card auth-card" data-mode="${mode}">
        <div class="auth-intro">
          <h1>${isSignUp ? 'Create your account' : 'Log in to Lyrcloud'}</h1>
          <p>${isSignUp ? 'Free forever on the Launch plan. No credit card required.' : 'Welcome back. Pick up where you left off.'}</p>
          <div class="provider-buttons">
            <button class="provider-button" type="button" data-login="google">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>
              ${isSignUp ? 'Sign up' : 'Continue'} with Google
            </button>
            ${GITHUB_SIGN_IN_ENABLED ? githubButton(isSignUp) : ''}
          </div>
          <p class="auth-divider"><span>or with email</span></p>
        </div>
        ${authSteps({ isSignUp })}
        <p class="auth-switch">${isSignUp ? 'Already have an account? <a class="text-link" href="/login/">Log in</a>' : 'New to Lyrcloud? <a class="text-link" href="/sign-up/">Create an account</a>'}</p>
      </div>
    </main>`;
};

// Lyrcloud Access: functions protected with "access" in lyrcloud.json send visitors here (src/access.js).
const accessPage = {
  route: '/access/',
  title: 'Lyrcloud Access',
  description: 'Sign in to open an app protected by Lyrcloud Access.',
  chrome: false,
  bodyClass: 'auth-body',
  scripts: ['/src/access.js'],
  body: `
    <main class="auth-page">
      <a class="brand auth-brand" href="/" aria-label="Lyrcloud home">${logo('auth')}</a>
      <div class="form-card glass-card auth-card access-card">
        <h1 class="access-title">Checking your access…</h1>
        <p class="access-text" aria-live="polite">One moment.</p>
        <div class="provider-buttons access-signin" hidden>
          <button class="provider-button" type="button" data-access-login="google">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>
            Continue with Google
          </button>
          <a class="provider-button access-email" href="/login/">Use email and password</a>
        </div>
        <div class="cta-row access-actions" hidden>
          <button class="button secondary access-switch" type="button">Use another account</button>
        </div>
        <p class="access-foot">Protected by <a class="text-link" href="/products/zero-trust/">Lyrcloud Access</a>.</p>
      </div>
    </main>`,
};

const loginPage = {
  route: '/login/',
  title: 'Log in',
  description: 'Log in to the Lyrcloud dashboard.',
  chrome: false,
  bodyClass: 'auth-body',
  scripts: ['/src/login.js'],
  body: authShell({ mode: 'login' }),
};

const signUpPage = {
  route: '/sign-up/',
  title: 'Sign up',
  description: 'Create a free Lyrcloud account and start building at the edge.',
  chrome: false,
  bodyClass: 'auth-body',
  scripts: ['/src/login.js'],
  body: authShell({ mode: 'sign-up' }),
};

// ---------------------------------------------------------------- Dashboard & errors

const dashboardPage = {
  route: '/dash/',
  title: 'Dashboard',
  description: 'Manage your Lyrcloud websites, DNS, security, and edge functions.',
  chrome: false,
  bodyClass: 'dash-body',
  styles: ['/src/dash.css'],
  scripts: ['/src/dash.js'],
  body: `<div id="app" class="dash-app"><p class="dash-loading">Loading dashboard…</p></div>`,
};

// Cognito's registered redirect URI is exactly /callback.html, so this path must not change.
const callbackPage = {
  route: '/callback.html',
  title: 'Signing in…',
  description: 'Completing sign-in to Lyrcloud.',
  chrome: false,
  bodyClass: 'auth-body',
  scripts: ['/src/callback.js'],
  body: `
    <main class="auth-page">
      <div class="form-card glass-card auth-card">
        <p id="callback-status">Signing you in…</p>
        <p><a class="text-link" id="callback-home-link" href="/" hidden>Back to Lyrcloud</a></p>
      </div>
    </main>`,
};

// The previous site's account page; keep old links working.
const legacyDashboardPage = {
  route: '/dashboard.html',
  title: 'Dashboard',
  description: 'Redirecting to the Lyrcloud dashboard.',
  chrome: false,
  body: `<meta http-equiv="refresh" content="0; url=/dash/" /><p><a href="/dash/">Continue to the dashboard</a></p>`,
};

const notFoundPage = {
  route: '/404.html',
  title: 'Page not found',
  description: 'The page you are looking for does not exist.',
  body: `
    <main>
${pageHero({
  eyebrow: 'Error 404',
  title: 'This route isn’t cached anywhere.',
  lede: 'The page you were looking for doesn’t exist or has moved.',
  ctas: '<a class="button primary large" href="/">Back to home</a><a class="button secondary large" href="/products/">Browse products</a>',
})}
    </main>`,
};

export const pages = [
  home,
  productsIndex,
  ...productPages,
  solutionsPage,
  developersPage,
  networkPage,
  domainsPage,
  lyrPage,
  pricingPage,
  aboutPage,
  contactPage,
  loginPage,
  signUpPage,
  accessPage,
  dashboardPage,
  callbackPage,
  legacyDashboardPage,
  notFoundPage,
];
