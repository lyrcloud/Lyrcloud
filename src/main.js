import { isLoggedIn, logout } from './auth.js';
import { avatarHtml, cachedProfile } from './avatar.js';
import { getSession } from './session.js';
import './lyrbot.js';

const menuButton = document.querySelector('.menu-button');
const header = document.querySelector('.site-header');

menuButton?.addEventListener('click', () => {
  const isOpen = header.classList.toggle('nav-open');
  menuButton.setAttribute('aria-expanded', String(isOpen));
  menuButton.textContent = isOpen ? '×' : '☰';
});

// Reveal sections and cards as they scroll into view (skipped for reduced-motion visitors).
const revealTargets = document.querySelectorAll(
  'main > section:not(.hero) .section-heading, .metric, .feature-card, .price-card, .workflow > *, .final-cta',
);
if (revealTargets.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const target of revealTargets) {
    // Stagger siblings in the same grid so cards cascade in.
    const index = [...target.parentElement.children].indexOf(target);
    target.style.setProperty('--reveal-delay', `${Math.min(index, 5) * 70}ms`);
    target.dataset.reveal = '';
    observer.observe(target);
  }
  document.documentElement.classList.add('reveal-ready');
}

const loginLink = document.getElementById('login-link');
if (loginLink && isLoggedIn()) {
  const session = getSession();
  // The dashboard caches the account's chosen name and photo; fall back to the sign-in claims.
  const person = { ...session, ...(cachedProfile() || {}) };
  if (!cachedProfile()) person.avatar = session.picture;
  const menu = document.createElement('div');
  menu.className = 'user-menu';
  menu.innerHTML = `
    <button class="user-menu-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="user-menu-panel">
      ${avatarHtml(person, 'user-avatar')}<span class="user-menu-label">Account</span><span class="user-menu-caret" aria-hidden="true">▾</span>
    </button>
    <div class="user-menu-panel" id="user-menu-panel" hidden>
      <div class="user-menu-who"><b></b><small></small></div>
      <a href="/dash/">Dashboard</a>
      <a href="/dash/#/settings">Profile and photo</a>
      <button class="user-menu-signout" type="button">Sign out</button>
    </div>`;
  menu.querySelector('.user-menu-who b').textContent = person.name || 'Signed in';
  menu.querySelector('.user-menu-who small').textContent = person.email || '';
  const button = menu.querySelector('.user-menu-button');
  const panel = menu.querySelector('.user-menu-panel');
  const setOpen = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  const signOut = menu.querySelector('.user-menu-signout');
  signOut.addEventListener('click', () => {
    signOut.disabled = true;
    signOut.textContent = 'Signing out…';
    logout();
  });
  loginLink.replaceWith(menu);
}
