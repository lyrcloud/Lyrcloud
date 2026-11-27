// The Lyrcloud platform function. Deployed functions' env bindings (env.MY_KV, env.MY_BUCKET, see
// runtime.mjs) invoke it with { token, op, store, ... }. The token is signed by the API at deploy time
// and names the function's owner, so a function only ever reaches its own owner's storage.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { perform, readToken, StorageError } from './storage.mjs';

export const secrets = new SecretsManagerClient({});
let secret;
export async function platformSecret() {
  if (process.env.PLATFORM_SECRET) return process.env.PLATFORM_SECRET;
  secret ??= (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.PLATFORM_SECRET_NAME }))).SecretString;
  return secret;
}

export const handler = async (event) => {
  const who = readToken(await platformSecret(), event?.token);
  if (!who) return { ok: false, status: 401, error: 'This function’s storage token isn’t valid. Deploy it again.' };
  try {
    return { ok: true, result: await perform(who.owner, event) };
  } catch (err) {
    if (err instanceof StorageError) return { ok: false, status: err.status, error: err.message };
    console.error('Storage call failed', who.fn, event?.op, err);
    return { ok: false, status: 500, error: 'Lyrcloud Storage had a problem. Try again.' };
  }
};
