// Session helpers for the API tests: a fixed signing secret, a hash of a known
// password, and the cookie a logged-in browser would send.

import type { AuthConfig } from "../src/app/api";
import { SESSION_COOKIE } from "../src/app/cookies";
import { signSession } from "../src/domain/auth";

export const TEST_PASSWORD = "open sesame";

/** hashPassword(TEST_PASSWORD), precomputed so tests don't pay scrypt's cost. */
export const TEST_PASSWORD_HASH =
  "scrypt$16384$8$1$QnqLQAHyfg215WpOtMzCPA$jf4bhE2Tc3Fwv3_Bzg1u9Z1fUFSSP2ltfbZ7jsMB96c";

export const TEST_SESSION_SECRET = "test-session-secret";

export const testAuth = (): AuthConfig => ({
  passwordHash: TEST_PASSWORD_HASH,
  sessionSecret: TEST_SESSION_SECRET,
  secureCookie: true,
});

/** The cookie a browser holding a session signed at `now` would send. */
export function sessionCookie(now: string, secret = TEST_SESSION_SECRET): string {
  const token = signSession(secret, Math.floor(Date.parse(now) / 1000));
  return `${SESSION_COOKIE}=${token}`;
}
