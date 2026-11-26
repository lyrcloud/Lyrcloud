// Calls to the Edge Functions API with your sign-in attached.
import { idToken } from './auth.mjs';
import { API_URL } from './config.mjs';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, { body, query } = {}) {
  if (API_URL.endsWith('.invalid')) throw new ApiError(0, 'This build of the CLI has no Lyrcloud API address. Update it with npm install -g lyrcloud@latest.');
  const token = await idToken();
  const url = new URL(API_URL + path);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, `Couldn’t reach Lyrcloud (${err.cause?.code || err.message}). Check your connection.`);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (response.status === 401) throw new ApiError(401, 'Your sign-in was refused. Run lyrcloud login again.');
  if (response.status === 413) throw new ApiError(413, data.error || 'The upload is too large.');
  if (!response.ok) throw new ApiError(response.status, data.error || data.message || `Lyrcloud answered ${response.status}.`);
  return data;
}
