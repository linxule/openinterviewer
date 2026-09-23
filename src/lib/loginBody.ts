// The Cloudflare sign-in body bound (gap F5), shared by POST /api/auth and the
// readiness validator, so a password the deployment accepts can always be
// sent. The installer (scripts/cloudflare/installer/model.mjs), the setup
// checker (via the installer module) and the operator CLI
// (scripts/cloudflare/operator.mjs) hold the same limit;
// tests/unit/adminPasswordLimit.test.ts ties them together.

/** Largest POST /api/auth body the Cloudflare target reads. */
export const MAX_CLOUDFLARE_LOGIN_BODY_BYTES = 1024;

/** UTF-8 size of the sign-in body carrying `password`, as the Login form and the operator CLI send it. */
export function loginBodyBytes(password: string): number {
  return new TextEncoder().encode(JSON.stringify({ password })).byteLength;
}

/**
 * Longest password, in UTF-16 code units (an input's maxLength unit), whose
 * sign-in body can fit: every code unit costs at least one byte of the body.
 */
export const MAX_LOGIN_PASSWORD_LENGTH = MAX_CLOUDFLARE_LOGIN_BODY_BYTES - loginBodyBytes('');
