// Account roles: "superadmin", "admin" or "user" (same model as Lyrshop).
//
// The super admin is never stored: it is derived on every request from the
// profile Cognito returns. Google sign-ins arrive with email_verified=false
// (the attribute isn't mapped) and the GitHub bridge passes through whatever
// email GitHub reports, so the email alone isn't proof of ownership. Google
// only issues @gmail.com identities to the mailbox owner, so the super admin
// must also have signed in through Google.
export const SUPER_ADMIN_PROVIDER = 'GoogleOIDC';
export const ASSIGNABLE_ROLES = ['admin', 'user'];

const KNOWN_PROVIDERS = ['GoogleOIDC', 'GitHubBridge'];

// Cognito builds federated usernames as "<provider>_<id>" but may lowercase the provider part
// ("googleoidc_123…"), so an exact match on "GoogleOIDC" never recognised the super admin.
// Map any casing back to the provider's configured name.
export function normalizeProvider(provider) {
  const raw = String(provider || '');
  return KNOWN_PROVIDERS.find((name) => name.toLowerCase() === raw.toLowerCase()) || raw || null;
}

export function roleFor(profile, superAdminEmail) {
  const email = String(profile?.email || '').toLowerCase();
  if (normalizeProvider(profile?.provider) === SUPER_ADMIN_PROVIDER && email && email === String(superAdminEmail).toLowerCase()) {
    return 'superadmin';
  }
  return profile?.role === 'admin' ? 'admin' : 'user';
}

export const isStaff = (role) => role === 'admin' || role === 'superadmin';

export const PLANS = ['launch', 'scale', 'enterprise'];
export const DEFAULT_PLAN = 'launch';
export const planFor = (profile) => (PLANS.includes(profile?.plan) ? profile.plan : DEFAULT_PLAN);

// Who manages whom (same rule as Lyrtrip): admins manage regular users; only the super admin
// manages admins; nobody manages the super admin through the admin API.
export function canManage(actorRole, targetRole) {
  if (targetRole === 'user') return isStaff(actorRole);
  if (targetRole === 'admin') return actorRole === 'superadmin';
  return false;
}

const EDITABLE_FIELDS = ['role', 'plan', 'disabled', 'name'];

// Returns [statusCode, message] when `actorRole` may not apply `changes` to an account whose role is
// `targetRole`, else null. `changes` may hold role, plan, disabled and name.
export function userUpdateError(actorRole, targetRole, changes) {
  if (!isStaff(actorRole)) return [403, 'Admins only.'];
  const keys = Object.keys(changes || {});
  if (!keys.length) return [400, 'Nothing to change.'];
  const unknown = keys.find((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown) return [400, `Unknown field "${unknown}".`];
  if (targetRole === 'superadmin') return [400, "The super admin's account can't be changed here."];
  if (!canManage(actorRole, targetRole)) return [403, 'Only the super admin can manage admins.'];
  if ('role' in changes) {
    const refused = roleChangeError(actorRole, targetRole, changes.role);
    if (refused) return refused;
  }
  if ('plan' in changes && !PLANS.includes(changes.plan)) return [400, `Plan must be one of ${PLANS.join(', ')}.`];
  if ('disabled' in changes && typeof changes.disabled !== 'boolean') return [400, '"disabled" must be true or false.'];
  if ('name' in changes && (typeof changes.name !== 'string' || changes.name.length > 120)) return [400, 'Name must be text of at most 120 characters.'];
  return null;
}

// Deleting an account: super admin only, never the super admin.
export function deleteUserError(actorRole, targetRole) {
  if (actorRole !== 'superadmin') return [403, 'Only the super admin can delete accounts.'];
  if (targetRole === 'superadmin') return [400, "The super admin's account can't be deleted."];
  return null;
}

// Returns [statusCode, message] when `actorRole` may not give `target` the role `newRole`, else null.
// Admins can see every account; only the super admin grants or removes admin.
export function roleChangeError(actorRole, targetRole, newRole) {
  if (actorRole !== 'superadmin') return [403, 'Only the super admin can change roles.'];
  if (!ASSIGNABLE_ROLES.includes(newRole)) return [400, 'Role must be "admin" or "user".'];
  if (targetRole === 'superadmin') return [400, "The super admin's role can't be changed."];
  return null;
}

// The account shape returned to the browser.
export function publicProfile(profile, superAdminEmail) {
  return {
    userId: profile.userId,
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    provider: normalizeProvider(profile.provider),
    role: roleFor(profile, superAdminEmail),
    plan: planFor(profile),
    disabled: profile.disabled === true && roleFor(profile, superAdminEmail) !== 'superadmin',
    createdAt: profile.createdAt ?? null,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}
