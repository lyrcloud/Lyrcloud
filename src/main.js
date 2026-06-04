const menuButton = document.querySelector('.menu-button');
const header = document.querySelector('.site-header');

menuButton?.addEventListener('click', () => {
  const isOpen = header.classList.toggle('nav-open');
  menuButton.setAttribute('aria-expanded', String(isOpen));
  menuButton.textContent = isOpen ? '×' : '☰';
});
