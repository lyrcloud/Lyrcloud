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
    createdAt: profile.createdAt ?? null,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}
