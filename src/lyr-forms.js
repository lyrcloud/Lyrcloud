// Lyrcloud's website forms go to Lyrsoft Marketing forms in the Lyrcloud workspace
// (lyrsoft.com/app/#/w/rTdTaUcI9YJo/marketing/forms) through the Lyrsoft work API's public endpoint,
// which allows www.lyrcloud.com in CORS (infra/aws/lyrsoft-work-api.yml in the Lyrsoft repo).
const LYRSOFT_API = 'https://zub5am2gj4.execute-api.us-east-1.amazonaws.com';
const WORKSPACE = 'rTdTaUcI9YJo';
export const LYR_FORMS = { contact: '-o20Q5BTrbRb', newsletter: 'JNdD19c0n-bV' };

export async function sendToLyrForm(formId, data) {
  const response = await fetch(`${LYRSOFT_API}/public/subscribe?w=${WORKSPACE}&f=${encodeURIComponent(formId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...data, page: location.href }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'Couldn’t send. Please try again.');
  return body;
}

// The footer's newsletter signup, on every page.
export function wireNewsletter() {
  const news = document.querySelector('#news-form');
  const status = document.querySelector('#news-status');
  if (!news || !status) return;
  news.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!news.reportValidity()) return;
    const button = news.querySelector('button');
    button.disabled = true;
    try {
      const result = await sendToLyrForm(LYR_FORMS.newsletter, Object.fromEntries(new FormData(news)));
      news.reset();
      status.textContent = result.message || 'Thanks! You’re subscribed.';
    } catch (error) {
      status.textContent = error instanceof TypeError ? 'Can’t reach us right now. Try again later.' : error.message;
    } finally {
      button.disabled = false;
    }
  });
}
