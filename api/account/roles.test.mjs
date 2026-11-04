import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicProfile, roleChangeError, roleFor } from './roles.mjs';

const SUPER = 'lyrclouds@gmail.com';

test('super admin needs the configured email and a Google sign-in', () => {
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'LyrClouds@gmail.com' }, SUPER), 'superadmin');
  assert.equal(roleFor({ provider: 'GitHubBridge', email: SUPER }, SUPER), 'user');
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: null }, SUPER), 'user');
});

test('provider names from Cognito match in any casing', () => {
  assert.equal(roleFor({ provider: 'googleoidc', email: SUPER }, SUPER), 'superadmin');
  assert.equal(roleFor({ provider: 'GOOGLEOIDC', email: SUPER }, SUPER), 'superadmin');
  assert.equal(roleFor({ provider: 'githubbridge', email: SUPER }, SUPER), 'user');
  assert.equal(publicProfile({ userId: 'u1', provider: 'googleoidc', email: SUPER }, SUPER).provider, 'GoogleOIDC');
});

test('stored roles: only "admin" is honoured, superadmin is never read from storage', () => {
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'a@b.com', role: 'admin' }, SUPER), 'admin');
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'a@b.com', role: 'superadmin' }, SUPER), 'user');
  assert.equal(roleFor({ provider: 'GoogleOIDC', email: 'a@b.com' }, SUPER), 'user');
});

test('only the super admin changes roles, and never their own', () => {
  assert.deepEqual(roleChangeError('admin', 'user', 'admin')?.[0], 403);
  assert.deepEqual(roleChangeError('user', 'user', 'admin')?.[0], 403);
  assert.deepEqual(roleChangeError('superadmin', 'user', 'superadmin')?.[0], 400);
  assert.deepEqual(roleChangeError('superadmin', 'superadmin', 'user')?.[0], 400);
  assert.equal(roleChangeError('superadmin', 'user', 'admin'), null);
  assert.equal(roleChangeError('superadmin', 'admin', 'user'), null);
});

test('publicProfile reports the derived role', () => {
  const profile = publicProfile({ userId: 'u1', provider: 'GoogleOIDC', email: SUPER, role: 'user' }, SUPER);
  assert.equal(profile.role, 'superadmin');
  assert.equal(profile.userId, 'u1');
});
