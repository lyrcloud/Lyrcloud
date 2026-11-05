import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logo } from '../src/logo.js';
import { products } from './products.mjs';

// Browsers cache favicons in their own long-lived store keyed by URL, so a redesigned icon at
// the same /favicon.svg can keep showing the old one for weeks. A content hash in the query
// string gives every icon change a fresh URL.
const iconFiles = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'site.webmanifest'];
const iconVersion = createHash('sha256')
  .update(iconFiles.map((file) => readFileSync(new URL(`../public/${file}`, import.meta.url))).join(''))
  .digest('hex')
  .slice(0, 8);

export const escape = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const navLink = (href, label, active) =>
  `<a href="${href}"${active === href ? ' aria-current="page"' : ''}>${label}</a>`;

function header(active) {
  const productLinks = products
    .map(
      (product) => `
          <a class="mega-item" href="/products/${product.slug}/">
            <span class="mega-icon" aria-hidden="true">${product.icon}</span>
            <span><b>${product.name}</b><small>${escape(product.tagline)}</small></span>
          </a>`,
    )
    .join('');

  return `
    <header class="site-header">
      <a class="brand" href="/" aria-label="Lyrcloud home">
        ${logo('header')}
      </a>
      <nav aria-label="Main navigation">
        <div class="nav-dropdown">
          <a href="/products/"${active.startsWith('/products/') ? ' aria-current="page"' : ''}>Products <span aria-hidden="true">▾</span></a>
          <div class="mega-menu">
            <div class="mega-grid">${productLinks}
            </div>
            <a class="mega-footer" href="/products/">View all products →</a>
          </div>
        </div>
        ${navLink('/solutions/', 'Solutions', active)}
        ${navLink('/developers/', 'Developers', active)}
        ${navLink('/network/', 'Network', active)}
        ${navLink('/domains/', 'Domains', active)}
        ${navLink('/pricing/', 'Pricing', active)}
      </nav>
      <div class="header-actions">
        <a class="link-button" href="/login/" id="login-link">Log in</a>
        <a class="button ghost" href="/contact/">Contact sales</a>
        <a class="button primary" href="/sign-up/">Start building</a>
      </div>
      <button class="menu-button" type="button" aria-label="Open menu" aria-expanded="false">☰</button>
    </header>`;
}

function footer() {
  const column = (title, links) => `
        <div>
          <h4>${title}</h4>
          ${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('\n          ')}
        </div>`;

  return `
    <footer class="footer">
      <div class="footer-brand">
        <div class="brand">${logo('footer')}</div>
        <p>Build, secure, and scale every digital experience on one global cloud.</p>
      </div>
      <div class="footer-columns">
        ${column('Products', products.map((product) => [`/products/${product.slug}/`, product.name]))}
        ${column('Developers', [
          ['/developers/', 'Developer hub'],
          ['/developers/#quickstart', 'Quickstart'],
          ['/developers/#cli', 'CLI reference'],
          ['/dash/', 'Dashboard'],
        ])}
        ${column('Company', [
          ['/about/', 'About'],
          ['/network/', 'Network'],
          ['/pricing/', 'Pricing'],
          ['/contact/', 'Contact sales'],
        ])}
      </div>
      <p class="footer-legal">© ${new Date().getFullYear()} Lyrcloud. All rights reserved.</p>
    </footer>`;
}

export function renderPage({ route, title, description, body, bodyClass = '', chrome = true, styles = [], scripts = [] }) {
  const fullTitle = route === '/' ? title : `${title} | Lyrcloud`;
  const styleTags = ['/src/styles.css', ...styles].map((href) => `<link rel="stylesheet" href="${href}" />`).join('\n    ');
  const scriptTags = (chrome ? ['/src/main.js', ...scripts] : scripts)
    .map((src) => `<script type="module" src="${src}"></script>`)
    .join('\n    ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escape(description)}" />
    <title>${escape(fullTitle)}</title>
    <link rel="icon" href="/favicon.ico?v=${iconVersion}" sizes="32x32" />
    <link rel="icon" href="/favicon.svg?v=${iconVersion}" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${iconVersion}" />
    <link rel="manifest" href="/site.webmanifest?v=${iconVersion}" />
    <meta name="theme-color" content="#0ea5e9" />
    ${styleTags}
  </head>
  <body${bodyClass ? ` class="${bodyClass}"` : ''}>${chrome ? header(route) : ''}
    ${body}${chrome ? footer() : ''}
    ${scriptTags}
  </body>
</html>
`;
}
