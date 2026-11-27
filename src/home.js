// Home page interactions: copy-to-clipboard, the clickable network demo, the edge function playground
// (runs your code in a sandboxed Web Worker in this browser), the typed terminal, count-up metrics and
// card spotlights. Everything degrades to a readable static page without JS or with reduced motion.

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

// ------------------------------------------------------------------ copy buttons

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    const label = button.querySelector('.copy-label') || button;
    const before = label.textContent;
    label.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      label.textContent = before;
      button.classList.remove('copied');
    }, 1600);
  });
}

// ------------------------------------------------------------------ network demo

const mapCard = document.querySelector('.map-card');
const globe = document.querySelector('.globe');
if (mapCard && globe) {
  if (finePointer && !reducedMotion) {
    const visual = document.querySelector('.hero-visual');
    visual.addEventListener('pointermove', (event) => {
      const box = mapCard.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      mapCard.style.setProperty('--tilt-x', `${(-y * 8).toFixed(2)}deg`);
      mapCard.style.setProperty('--tilt-y', `${(x * 10).toFixed(2)}deg`);
    });
    visual.addEventListener('pointerleave', () => {
      mapCard.style.setProperty('--tilt-x', '0deg');
      mapCard.style.setProperty('--tilt-y', '0deg');
    });
  }

  const nodes = [...globe.querySelectorAll('.node')];
  const log = document.querySelector('.demo-log');
  const counters = {
    requests: document.querySelector('[data-demo="requests"]'),
    latency: document.querySelector('[data-demo="latency"]'),
    blocked: document.querySelector('[data-demo="blocked"]'),
  };
  const stats = { requests: 0, totalMs: 0, blocked: 0 };
  const paths = ['/', '/api/time', '/shop', '/login', '/images/hero.webp', '/api/cart'];
  const cities = ['Virginia', 'Frankfurt', 'Singapore', 'São Paulo', 'Mumbai', 'Sydney', 'Tokyo', 'London'];

  function send(x, y) {
    const box = globe.getBoundingClientRect();
    // The nearest node answers.
    let nearest = nodes[0];
    let best = Infinity;
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - box.left - x, r.top + r.height / 2 - box.top - y);
      if (d < best) {
        best = d;
        nearest = node;
      }
    }
    const target = nearest.getBoundingClientRect();
    const tx = target.left + target.width / 2 - box.left;
    const ty = target.top + target.height / 2 - box.top;

    const dot = document.createElement('span');
    dot.className = 'packet';
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    globe.append(dot);
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    globe.append(ripple);
    const duration = reducedMotion ? 0 : 260 + best * 2.2;
    dot.animate([{ transform: 'translate(-50%, -50%)' }, { transform: `translate(calc(${tx - x}px - 50%), calc(${ty - y}px - 50%))` }], { duration, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
    setTimeout(() => {
      dot.remove();
      nearest.classList.remove('hit');
      void nearest.offsetWidth;
      nearest.classList.add('hit');
    }, duration);
    setTimeout(() => ripple.remove(), 700);

    const ms = Math.round(8 + best / 6 + Math.random() * 6);
    const bot = Math.random() < 0.18;
    stats.requests += 1;
    stats.totalMs += ms;
    if (bot) stats.blocked += 1;
    counters.requests.textContent = stats.requests;
    counters.latency.textContent = `${Math.round(stats.totalMs / stats.requests)} ms`;
    counters.blocked.textContent = stats.blocked;
    if (log) {
      const path = paths[Math.floor(Math.random() * paths.length)];
      const city = cities[nodes.indexOf(nearest) % cities.length];
      const line = document.createElement('li');
      line.innerHTML = bot
        ? `<b class="bad">403</b> GET ${path} <span>bot challenged · ${city}</span>`
        : `<b>200</b> GET ${path} <span>${city} · ${ms} ms</span>`;
      log.prepend(line);
      while (log.children.length > 3) log.lastElementChild.remove();
    }
  }

  globe.addEventListener('click', (event) => {
    const box = globe.getBoundingClientRect();
    send(event.clientX - box.left, event.clientY - box.top);
  });
  globe.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const box = globe.getBoundingClientRect();
    send(Math.random() * box.width, Math.random() * box.height);
  });

  // A few requests on their own so the card isn't idle, until the visitor clicks.
  if (!reducedMotion) {
    let auto = 0;
    const timer = setInterval(() => {
      const box = globe.getBoundingClientRect();
      if (box.width) send(Math.random() * box.width, Math.random() * box.height);
      auto += 1;
      if (auto >= 4) clearInterval(timer);
    }, 1400);
    globe.addEventListener('click', () => clearInterval(timer), { once: true });
  }
}

// ------------------------------------------------------------------ playground

const PRESETS = {
  hello: {
    path: '/',
    code: `export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return new Response(\`\${env.GREETING} from \${url.hostname}!\`);
  },
};`,
  },
  json: {
    path: '/api/time?tz=UTC',
    code: `export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/time') {
      return Response.json({
        now: new Date().toISOString(),
        tz: url.searchParams.get('tz') ?? 'UTC',
      });
    }
    return new Response('Not found', { status: 404 });
  },
};`,
  },
  redirect: {
    path: '/old-blog/hello',
    code: `const moved = { '/old-blog': '/blog' };

export default {
  fetch(request) {
    const url = new URL(request.url);
    for (const [from, to] of Object.entries(moved)) {
      if (url.pathname.startsWith(from)) {
        url.pathname = url.pathname.replace(from, to);
        return Response.redirect(url, 301);
      }
    }
    return new Response('Page');
  },
};`,
  },
  headers: {
    path: '/whoami',
    code: `export default {
  fetch(request) {
    const headers = Object.fromEntries(request.headers);
    return Response.json({
      method: request.method,
      path: new URL(request.url).pathname,
      ip: request.geo.ip,
      headers,
    }, { headers: { 'cache-control': 'no-store' } });
  },
};`,
  },
};

const playground = document.querySelector('.playground');
if (playground) {
  const editor = playground.querySelector('#pg-code');
  const pathInput = playground.querySelector('#pg-path');
  const method = playground.querySelector('#pg-method');
  const status = playground.querySelector('.pg-status');
  const meta = playground.querySelector('.pg-meta');
  const output = playground.querySelector('.pg-output');
  const runButton = playground.querySelector('.pg-run');
  const tabs = [...playground.querySelectorAll('[data-preset]')];

  const select = (name) => {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.preset === name));
    editor.value = PRESETS[name].code;
    pathInput.value = PRESETS[name].path;
    run();
  };
  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.preset));

  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      run();
    }
  });
  runButton.addEventListener('click', run);
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });

  // The visitor's module runs in its own Web Worker with no access to this page, and is stopped
  // if it doesn't answer within 3 seconds.
  function run() {
    const userUrl = URL.createObjectURL(new Blob([editor.value], { type: 'text/javascript' }));
    const runner = `
      self.onmessage = async ({ data }) => {
        try {
          const mod = await import(data.userUrl);
          const app = mod.default;
          const handler = typeof app === 'function' ? app : app && app.fetch;
          if (typeof handler !== 'function') throw new Error('Export default { fetch(request) { ... } }');
          const request = new Request(data.url, { method: data.method, headers: { 'user-agent': data.ua, accept: '*/*' } });
          Object.defineProperty(request, 'geo', { value: { ip: '203.0.113.7', city: null, region: null, country: null } });
          const response = await handler.call(app, request, { GREETING: 'Hello' }, { waitUntil() {}, passThroughOnException() {} });
          if (!(response instanceof Response)) throw new Error('fetch() must return a Response');
          self.postMessage({ ok: true, status: response.status, statusText: response.statusText, headers: [...response.headers], body: await response.text() });
        } catch (error) {
          self.postMessage({ ok: false, error: String((error && error.message) || error) });
        }
      };`;
    const runnerUrl = URL.createObjectURL(new Blob([runner], { type: 'text/javascript' }));
    const worker = new Worker(runnerUrl, { type: 'module' });
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(userUrl);
      URL.revokeObjectURL(runnerUrl);
    };
    const show = (kind, label, info, body) => {
      status.className = `pg-status ${kind}`;
      status.textContent = label;
      meta.textContent = info;
      output.textContent = body;
      output.parentElement.classList.remove('flash');
      void output.offsetWidth;
      output.parentElement.classList.add('flash');
    };
    const started = performance.now();
    runButton.disabled = true;
    const timer = setTimeout(() => {
      cleanup();
      runButton.disabled = false;
      show('error', 'Timeout', '3 s', 'Your function didn’t return a Response within 3 seconds.');
    }, 3000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      cleanup();
      runButton.disabled = false;
      const elapsed = `${Math.max(1, Math.round(performance.now() - started))} ms`;
      if (!data.ok) {
        show('error', 'Error', elapsed, data.error);
        return;
      }
      let body = data.body;
      const type = (data.headers.find(([key]) => key === 'content-type') || [])[1] || '';
      if (type.includes('json')) {
        try {
          body = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          // show as sent
        }
      }
      const headerLines = data.headers.map(([key, value]) => `${key}: ${value}`).join('\n');
      const kind = data.status >= 400 ? 'error' : data.status >= 300 ? 'redirect' : 'ok';
      show(kind, `${data.status} ${data.statusText || ''}`.trim(), elapsed, `${headerLines}${headerLines ? '\n\n' : ''}${body}`);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      clearTimeout(timer);
      cleanup();
      runButton.disabled = false;
      show('error', 'Syntax error', '', event.message || 'Your code couldn’t be loaded. Check for a typo.');
    };
    const path = pathInput.value.trim() || '/';
    worker.postMessage({ userUrl, method: method.value, ua: navigator.userAgent, url: `https://hello-edge.dev.lyr${path.startsWith('/') ? path : `/${path}`}` });
  }

  // Run once when the playground first scrolls into view.
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        seen.disconnect();
        run();
      }
    });
    seen.observe(playground);
  } else {
    run();
  }
}

// ------------------------------------------------------------------ typed terminal

const typed = document.querySelector('[data-typed]');
if (typed) {
  const lines = JSON.parse(typed.dataset.typed);
  const replay = document.querySelector('.terminal-replay');
  let runId = 0;

  const renderAll = () => {
    typed.innerHTML = '';
    for (const line of lines) {
      const span = document.createElement('span');
      span.className = line.kind;
      span.textContent = line.text;
      typed.append(span);
    }
  };

  async function play() {
    const id = (runId += 1);
    typed.innerHTML = '';
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const line of lines) {
      if (id !== runId) return;
      const span = document.createElement('span');
      span.className = line.kind;
      typed.append(span);
      if (line.kind === 'cmd') {
        span.classList.add('typing');
        for (const char of line.text) {
          if (id !== runId) return;
          span.textContent += char;
          await wait(char === ' ' ? 55 : 28 + Math.random() * 40);
        }
        span.classList.remove('typing');
        await wait(380);
      } else {
        span.textContent = line.text;
        await wait(line.kind === 'gap' ? 220 : 170);
      }
    }
  }

  if (reducedMotion || !('IntersectionObserver' in window)) {
    renderAll();
  } else {
    renderAll();
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        watcher.disconnect();
        play();
      }
    }, { threshold: 0.4 });
    watcher.observe(typed);
  }
  replay?.addEventListener('click', () => (reducedMotion ? renderAll() : play()));
}

// ------------------------------------------------------------------ count-up metrics

const counts = document.querySelectorAll('[data-count]');
if (counts.length && !reducedMotion && 'IntersectionObserver' in window) {
  const animate = (el) => {
    const target = Number(el.dataset.count);
    const decimals = (el.dataset.count.split('.')[1] || '').length;
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const start = performance.now();
    const duration = 1100;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = `${prefix}${(target * eased).toFixed(decimals)}${suffix}`;
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      watcher.unobserve(entry.target);
      animate(entry.target);
    }
  }, { threshold: 0.6 });
  for (const el of counts) watcher.observe(el);
}

// ------------------------------------------------------------------ card spotlight

if (finePointer && !reducedMotion) {
  for (const card of document.querySelectorAll('.feature-card, .price-card')) {
    card.addEventListener('pointermove', (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty('--spot-x', `${event.clientX - box.left}px`);
      card.style.setProperty('--spot-y', `${event.clientY - box.top}px`);
    });
  }
}
