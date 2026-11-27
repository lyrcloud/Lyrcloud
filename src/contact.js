// lyrcloud.com contact sales form: sent to the "lyrcloud.com · Contact sales" form in Lyrsoft Marketing
// (lyrsoft.com/app/#/w/rTdTaUcI9YJo/marketing/forms), which keeps the message, files it in the
// support@lyrcloud.com inbox in Lyrsoft Mail and adds people who opt in to the audience.
import { sendToLyrForm, LYR_FORMS } from './lyr-forms.js';

const form = document.querySelector('#contact-form');
const status = document.querySelector('#contact-status');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  status.classList.remove('form-error-text', 'form-ok-text');
  status.textContent = 'Sending…';
  try {
    const result = await sendToLyrForm(LYR_FORMS.contact, Object.fromEntries(new FormData(form)));
    form.reset();
    status.classList.add('form-ok-text');
    status.textContent = result.message || 'Thanks! We’ll reply within one business day.';
  } catch (error) {
    status.classList.add('form-error-text');
    status.textContent = error instanceof TypeError ? 'Can’t reach us right now. Email support@lyrcloud.com instead.' : error.message;
  } finally {
    button.disabled = false;
  }
});
