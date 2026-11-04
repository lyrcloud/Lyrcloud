import { isLoggedIn, logout } from './auth.js';
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
  const pill = document.createElement('div');
  pill.className = 'user-pill';
  if (session.picture) {
    const avatar = document.createElement('img');
    avatar.className = 'user-avatar';
    avatar.src = session.picture;
    avatar.alt = '';
    pill.append(avatar);
  }
  const dashboard = document.createElement('a');
  dashboard.className = 'link-button';
  dashboard.href = '/dash/';
  dashboard.textContent = 'Dashboard';
  const logoutButton = document.createElement('button');
  logoutButton.className = 'link-button';
  logoutButton.type = 'button';
  logoutButton.textContent = 'Log out';
  logoutButton.addEventListener('click', logout);
  pill.append(dashboard, logoutButton);
  loginLink.replaceWith(pill);
}
