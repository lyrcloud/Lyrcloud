const form = document.querySelector('#contact-form');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const subject = `Sales inquiry from ${data.company || data.name}`;
  const body = [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Company: ${data.company || '—'}`,
    `Monthly traffic: ${data.traffic}`,
    '',
    data.message,
  ].join('\n');
  location.href = `mailto:support@lyrcloud.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});
