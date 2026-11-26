// Where the CLI talks to and where it keeps your sign-in.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The Edge Functions API (stack lyrcloud-functions). LYRCLOUD_API_URL overrides it.
export const DEFAULT_API = 'https://0mxmbgsbqd.execute-api.us-east-1.amazonaws.com';
export const API_URL = (process.env.LYRCLOUD_API_URL || DEFAULT_API).replace(/\/$/, '');

// The same Cognito app the website signs in with. Its allowed callbacks include
// http://localhost:5173/callback.html and :5174, which `lyrcloud login` listens on.
export const COGNITO_DOMAIN = 'lyrcloud-auth.auth.us-east-1.amazoncognito.com';
export const COGNITO_REGION = 'us-east-1';
export const CLIENT_ID = '5h78n6dkjbhq92423lscfllj6t';
export const LOGIN_PORTS = [5173, 5174];
export const FUNCTIONS_DOMAIN = 'dev.lyr';
export const DOCS_URL = 'https://www.lyrcloud.com/developers/';
export const LYR_SETUP_URL = 'https://www.lyrcloud.com/lyr/';

const configDir = () => {
  if (process.env.LYRCLOUD_CONFIG_DIR) return process.env.LYRCLOUD_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'lyrcloud');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'lyrcloud');
};
export const credentialsPath = () => path.join(configDir(), 'credentials.json');

export function readCredentials() {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return null;
  }
}

// Only you can read the file: it holds a refresh token that's good for 30 days.
export function writeCredentials(credentials) {
  const file = credentialsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: permissions come from the user profile folder
  }
}

export function deleteCredentials() {
  const file = credentialsPath();
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
