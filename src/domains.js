// The public /domains/ page: searches the domains API and lists prices. Buying happens in the
// dashboard (/dash/#/domains/buy), which asks visitors to sign in first.
import { DOMAINS_API_BASE } from './auth.js';

const form = document.getElementById('domain-search');
const input = document.getElementById('domain-query');
const status = document.getElementById('domain-status');
const results = document.getElementById('domain-results');
const prices = document.getElementById('domain-prices');

const money = (cents) => (Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : '—');
const buyUrl = (domain, action) => `/dash/#/domains/buy?domain=${encodeURIComponent(domain)}${action ? `&action=${action}` : ''}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function row(item) {
  let note;
  let action = null;
  if (item.available) {
    note = el('span', { class: 'domain-price' }, el('b', {}, money(item.price)), el('small', {}, `first year · renews at ${money(item.renew)}/yr`));
    action = el('a', { class: 'button primary', href: buyUrl(item.domain) }, 'Buy');
  } else if (item.status === 'UNAVAILABLE') {
    note = el('span', { class: 'domain-price muted' }, 'Taken');
    action = el('a', { class: 'button ghost', href: buyUrl(item.domain, 'transfer') }, 'Own it? Transfer in');
  } else if (item.status === 'NOT_SOLD') {
    note = el('span', { class: 'domain-price muted' }, `We don’t sell .${item.tld} yet`);
  } else {
    note = el('span', { class: 'domain-price muted' }, 'Couldn’t check right now');
    action = el('button', { class: 'button ghost', type: 'button', 'data-q': item.domain }, 'Check again');
  }
  return el('li', { class: `domain-result${item.available ? ' is-available' : ''}` }, el('span', { class: 'domain-name' }, item.domain), note, action);
}

async function search(query) {
  status.textContent = 'Searching…';
  results.replaceChildren();
  form.querySelector('button').disabled = true;
  try {
    const response = await fetch(`${DOMAINS_API_BASE}/public/domains/search?q=${encodeURIComponent(query)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Search is unavailable right now. Please try again.');
    status.textContent = data.results.some((item) => item.available) ? '' : `No exact matches for “${data.query}” are free.`;
    results.append(el('ul', { class: 'domain-results' }, ...data.results.map(row)));
    if (data.suggestions.length) {
      results.append(el('h3', { class: 'domain-subhead' }, 'More ideas'), el('ul', { class: 'domain-results' }, ...data.suggestions.map(row)));
    }
  } catch (error) {
    status.textContent = error.message;
  }
  form.querySelector('button').disabled = false;
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  history.replaceState(null, '', `?q=${encodeURIComponent(query)}`);
  search(query);
});

results?.addEventListener('click', (event) => {
  const again = event.target.closest('[data-q]');
  if (again) search(again.dataset.q);
});

async function loadPrices() {
  try {
    const response = await fetch(`${DOMAINS_API_BASE}/public/domains/prices`);
    const data = await response.json();
    if (!response.ok) throw new Error();
    prices.replaceChildren(...data.tlds.map((item) => el('tr', {},
      el('td', {}, el('b', {}, `.${item.tld}`)),
      el('td', {}, money(item.register)),
      el('td', {}, money(item.renew)),
      el('td', {}, money(item.transfer)),
    )));
  } catch {
    prices.replaceChildren(el('tr', {}, el('td', { colspan: '4' }, 'Prices are unavailable right now.')));
  }
}

if (prices) loadPrices();
const initial = new URLSearchParams(location.search).get('q');
if (initial && input) {
  input.value = initial;
  search(initial);
}
