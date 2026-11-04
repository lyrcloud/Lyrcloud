import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarFor, canManage, deleteUserError, planFor, publicProfile, roleChangeError, roleFor, selfUpdateError, userUpdateError } from './roles.mjs';

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

test('plans default to launch and only known plans are reported', () => {
  assert.equal(planFor({}), 'launch');
  assert.equal(planFor({ plan: 'scale' }), 'scale');
  assert.equal(planFor({ plan: 'gold' }), 'launch');
  assert.equal(publicProfile({ userId: 'u1', plan: 'enterprise' }, SUPER).plan, 'enterprise');
});

test('admins manage users, only the super admin manages admins, nobody manages the super admin', () => {
  assert.equal(canManage('admin', 'user'), true);
  assert.equal(canManage('admin', 'admin'), false);
  assert.equal(canManage('superadmin', 'admin'), true);
  assert.equal(canManage('superadmin', 'superadmin'), false);
  assert.equal(canManage('user', 'user'), false);
});

test('account updates', () => {
  assert.equal(userUpdateError('admin', 'user', { plan: 'scale', disabled: true, name: 'Ann' }), null);
  assert.deepEqual(userUpdateError('admin', 'user', { role: 'admin' })?.[0], 403);
  assert.deepEqual(userUpdateError('admin', 'admin', { plan: 'scale' })?.[0], 403);
  assert.equal(userUpdateError('superadmin', 'admin', { plan: 'enterprise', disabled: false }), null);
  assert.deepEqual(userUpdateError('superadmin', 'superadmin', { plan: 'scale' })?.[0], 400);
  assert.deepEqual(userUpdateError('superadmin', 'user', { plan: 'gold' })?.[0], 400);
  assert.deepEqual(userUpdateError('superadmin', 'user', { disabled: 'yes' })?.[0], 400);
  assert.deepEqual(userUpdateError('superadmin', 'user', { email: 'x@y.z' })?.[0], 400);
  assert.deepEqual(userUpdateError('superadmin', 'user', {})?.[0], 400);
  assert.deepEqual(userUpdateError('user', 'user', { plan: 'scale' })?.[0], 403);
});

test('only the super admin deletes accounts, never their own', () => {
  assert.equal(deleteUserError('superadmin', 'user'), null);
  assert.equal(deleteUserError('superadmin', 'admin'), null);
  assert.deepEqual(deleteUserError('admin', 'user')?.[0], 403);
  assert.deepEqual(deleteUserError('superadmin', 'superadmin')?.[0], 400);
});

test('a disabled flag is never reported for the super admin', () => {
  assert.equal(publicProfile({ userId: 'u1', provider: 'GoogleOIDC', email: SUPER, disabled: true }, SUPER).disabled, false);
  assert.equal(publicProfile({ userId: 'u2', disabled: true }, SUPER).disabled, true);
});

test('profile photos: uploads win, "initials" hides the photo, otherwise the provider photo', () => {
  const upload = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(avatarFor({ picture: 'https://g/p.jpg', avatar: upload }), upload);
  assert.equal(avatarFor({ picture: 'https://g/p.jpg', avatar: 'initials' }), null);
  assert.equal(avatarFor({ picture: 'https://g/p.jpg' }), 'https://g/p.jpg');
  assert.equal(avatarFor({ picture: 'https://g/p.jpg', avatar: 'javascript:alert(1)' }), 'https://g/p.jpg');
  assert.equal(selfUpdateError({ avatar: upload }), null);
  assert.equal(selfUpdateError({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })?.[0], 400);
  assert.equal(selfUpdateError({ avatar: `data:image/jpeg;base64,${'A'.repeat(70_000)}` })?.[0], 400);
  assert.equal(selfUpdateError({ plan: 'scale', name: 'Ada' }), null);
  assert.equal(selfUpdateError({ role: 'admin' })?.[0], 400);
});
