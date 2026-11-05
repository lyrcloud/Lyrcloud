// The /lyr/ page: looks .lyr names up through the domains API and copies the resolver address.
import { DOMAINS_API_BASE } from './auth.js';

const form = document.getElementById('lyr-lookup');
const result = document.getElementById('lyr-result');

function show(lines, ok) {
  result.replaceChildren(...lines.map((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    return p;
  }));
  result.dataset.state = ok ? 'ok' : 'none';
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('lyr-name').value.trim().toLowerCase();
  const type = document.getElementById('lyr-type').value;
  if (!name) return;
  show(['Looking it up…'], true);
  try {
    const response = await fetch(`${DOMAINS_API_BASE}/public/lyr/lookup?name=${encodeURIComponent(name)}&type=${type}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Lookup failed.');
    if (data.status === 'NXDOMAIN') return show([`${data.name} doesn’t exist yet.`], false);
    if (!data.answers.length) return show([`${data.name} exists but has no ${data.type} records.`], false);
    show(data.answers.map((answer) => `${answer.name}  ${answer.type}  ${answer.value}`), true);
  } catch (error) {
    show([error.message], false);
  }
});

// Reserve: check the name, then send people to the dashboard (sign-in required) to reserve it.
const reserveForm = document.getElementById('lyr-reserve');
const reserveResult = document.getElementById('lyr-reserve-result');
reserveForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('lyr-reserve-name').value.trim().toLowerCase();
  if (!name) return;
  reserveResult.textContent = 'Checking…';
  try {
    const response = await fetch(`${DOMAINS_API_BASE}/public/lyr/available?name=${encodeURIComponent(name)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Couldn’t check that name.');
    if (!data.available) {
      reserveResult.dataset.state = 'none';
      reserveResult.textContent = { reserved: `${data.name} is kept for Lyrcloud.`, taken: `${data.name} is already in use.`, waitlisted: `Someone has already reserved ${data.name}.` }[data.reason] || `${data.name} isn’t available.`;
      return;
    }
    reserveResult.dataset.state = 'ok';
    const link = document.createElement('a');
    link.className = 'button primary';
    link.href = `/dash/#/domains?reserve=${encodeURIComponent(data.name)}`;
    link.textContent = `Reserve ${data.name}`;
    const note = document.createElement('p');
    note.textContent = `${data.name} is free to reserve.`;
    reserveResult.replaceChildren(note, link);
  } catch (error) {
    reserveResult.dataset.state = 'none';
    reserveResult.textContent = error.message;
  }
});

document.getElementById('lyr-copy')?.addEventListener('click', async (event) => {
  const text = document.getElementById('lyr-resolver').textContent;
  try {
    await navigator.clipboard.writeText(text);
    event.target.textContent = 'Copied';
  } catch {
    event.target.textContent = 'Select and copy';
  }
  setTimeout(() => { event.target.textContent = 'Copy'; }, 2000);
});
