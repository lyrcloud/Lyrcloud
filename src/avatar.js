// Profile avatars, shared by the site header (src/main.js) and the dashboard (src/dash.js).
//
// An avatar is the person's initial on a gradient, with their photo laid over it when there is one.
// If the photo fails to load (Google photo URLs refuse requests that send a Referer, and links expire),
// the image is removed and the initial shows through instead of a broken-image icon.

const PROFILE_KEY = 'lyrcloud.profile';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const initialOf = (person) => (String(person?.name || person?.email || '?').trim()[0] || '?').toUpperCase();

// Only https photos and the data: URLs the API accepts are ever put in an <img src>.
const safeSrc = (src) => (typeof src === 'string' && /^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/.test(src) ? src : '');

export function avatarHtml(person, className = 'avatar') {
  // `avatar` (from the API) wins even when null, which means the person removed their photo.
  const src = safeSrc(person && 'avatar' in person ? person.avatar : person?.picture);
  return `<span class="${className}" aria-hidden="true"><span>${esc(initialOf(person))}</span>${
    src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer" decoding="async" />` : ''
  }</span>`;
}

// One capturing listener covers every avatar image, including ones rendered later.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.parentElement?.matches('.avatar, .user-avatar')) img.remove();
  },
  true,
);

// The dashboard stores the account's name and avatar here after GET /me, so the site header can show
// the same picture without an extra API call. Cleared on sign-out with the rest of sessionStorage.
export function cacheProfile(profile) {
  try {
    sessionStorage.setItem(PROFILE_KEY, JSON.stringify({ name: profile.name, email: profile.email, avatar: profile.avatar ?? null }));
  } catch {}
}

export function cachedProfile() {
  try {
    return JSON.parse(sessionStorage.getItem(PROFILE_KEY) || 'null');
  } catch {
    return null;
  }
}

// Turns a picked image file into a square JPEG data URL small enough for the profile API (≤ 45 KB).
export async function imageFileToAvatar(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose an image file (JPEG, PNG, WebP or HEIC).');
  if (file.size > 15 * 1024 * 1024) throw new Error('That image is over 15 MB. Choose a smaller one.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This browser can’t read that image. Try a JPEG or PNG.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  for (const size of [256, 192, 128]) {
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size, size);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    for (const quality of [0.86, 0.76, 0.64]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= 60_000) return url;
    }
  }
  throw new Error('Couldn’t make that image small enough. Try another photo.');
}
