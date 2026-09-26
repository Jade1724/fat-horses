// Authentication (SPEC.md F11): one shared password for everyone who uses the
// app, checked against a stored scrypt hash and exchanged for a short-lived
// signed session token. Only node:crypto, so this unit-tests without I/O.

import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** scrypt work factors. Every hash records its own, so these can be raised. */
interface Cost {
  N: number;
  r: number;
  p: number;
}

const COST: Cost = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Room for a later, costlier COST without touching stored hashes. */
const MAX_MEM = 64 * 1024 * 1024;

/** How long a session lasts before the password is asked for again (F11.2). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { ...cost, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * `scrypt$N$r$p$salt$hash`. Safe to store where the password itself would not
 * be: it cannot be reversed or replayed, only checked against a guess.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${b64(salt)}$${b64(key)}`;
}

/** True when `password` is the one `stored` was made from. Malformed → false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltText, hashText] = stored.trim().split("$");
  if (scheme !== "scrypt") return false;
  if (
    n === undefined ||
    r === undefined ||
    p === undefined ||
    saltText === undefined ||
    hashText === undefined
  )
    return false;

  const cost: Cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Object.values(cost).every((v) => Number.isInteger(v) && v > 0)) return false;
  if (128 * cost.N * cost.r > MAX_MEM) return false;

  const expected = unb64(hashText);
  if (expected.length !== KEY_BYTES) return false;

  try {
    return timingSafeEqual(await derive(password, unb64(saltText), cost), expected);
  } catch {
    return false;
  }
}

/** A session's lifetime. There is no identity to carry: one password, one view. */
export interface Session {
  iat: number;
  exp: number;
}

export type SessionCheck = { valid: true; session: Session } | { valid: false; reason: SessionProblem };

export type SessionProblem = "missing" | "malformed" | "bad signature" | "expired";

/** A random session-signing secret, base64url. Rotating it ends every session. */
export function newSessionSecret(): string {
  return b64(randomBytes(32));
}

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** A JWT (HS256) valid for `ttlSeconds` from `nowSeconds`. */
export function signSession(secret: string, nowSeconds: number, ttlSeconds = SESSION_TTL_SECONDS): string {
  const header = b64(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const session: Session = { iat: nowSeconds, exp: nowSeconds + ttlSeconds };
  const payload = b64(Buffer.from(JSON.stringify(session)));
  const body = `${header}.${payload}`;
  return `${body}.${signature(secret, body)}`;
}

/** Checks the signature in constant time, then the expiry. */
export function verifySession(secret: string, token: string | undefined, nowSeconds: number): SessionCheck {
  if (!token) return { valid: false, reason: "missing" };

  const parts = token.split(".");
  const [header, payload, given] = parts;
  if (parts.length !== 3 || header === undefined || payload === undefined || given === undefined)
    return { valid: false, reason: "malformed" };

  const expected = signature(secret, `${header}.${payload}`);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad signature" };

  const session = readSession(payload);
  if (!session) return { valid: false, reason: "malformed" };
  return session.exp <= nowSeconds ? { valid: false, reason: "expired" } : { valid: true, session };
}

function readSession(payload: string): Session | null {
  try {
    const value: unknown = JSON.parse(unb64(payload).toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { iat, exp } = value as Record<string, unknown>;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    return { iat: iat as number, exp: exp as number };
  } catch {
    return null;
  }
}
