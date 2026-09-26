// The session cookie (SPEC.md F11.2). HttpOnly keeps the token out of reach of
// page scripts, so an injected script cannot carry a session away; SameSite
// keeps it off cross-site requests. Secure is dropped for the local server,
// which serves plain http.

export const SESSION_COOKIE = "fh_session";

/**
 * One cookie's value, from a `Cookie:` header or from API Gateway's list of
 * `name=value` strings. Undefined when it isn't there.
 */
export function cookieValue(
  name: string,
  cookies: string | readonly string[] | undefined,
): string | undefined {
  if (!cookies) return undefined;
  const pairs = (Array.isArray(cookies) ? cookies : String(cookies).split(";")) as readonly string[];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim() || undefined;
  }
  return undefined;
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) attributes.push("Secure");
  return [`${SESSION_COOKIE}=${value}`, ...attributes].join("; ");
}

/** Sets the session for `ttlSeconds`. */
export function sessionCookie(token: string, ttlSeconds: number, secure: boolean): string {
  return cookie(token, ttlSeconds, secure);
}

/** Expires the session now, so logging out leaves nothing behind. */
export function clearedSessionCookie(secure: boolean): string {
  return cookie("", 0, secure);
}
