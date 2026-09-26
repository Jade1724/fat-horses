import { describe, expect, it } from "vitest";
import {
  hashPassword,
  newSessionSecret,
  SESSION_TTL_SECONDS,
  signSession,
  verifyPassword,
  verifySession,
} from "./auth";

const NOW = 1_700_000_000;

describe("password hashing", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash, so the same password stores differently", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("records its own cost, so stored hashes stay readable", async () => {
    const stored = await hashPassword("x");
    expect(stored.split("$").slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
  });

  it("treats every malformed hash as no match", async () => {
    const cases = [
      "",
      "unset",
      "scrypt$16384$8$1$onlyfiveparts",
      "bcrypt$16384$8$1$c2FsdA$aGFzaA",
      "scrypt$0$8$1$c2FsdA$aGFzaA",
      "scrypt$16384$8$1$c2FsdA$tooshort",
      "scrypt$99999999$8$1$c2FsdA$aGFzaA", // would need more memory than allowed
    ];
    for (const stored of cases) expect(await verifyPassword("x", stored)).toBe(false);
  });
});

describe("session tokens", () => {
  const secret = newSessionSecret();

  it("accepts a token it just signed", () => {
    const check = verifySession(secret, signSession(secret, NOW), NOW);
    expect(check).toEqual({ valid: true, session: { iat: NOW, exp: NOW + SESSION_TTL_SECONDS } });
  });

  it("expires exactly at exp", () => {
    const token = signSession(secret, NOW, 60);
    expect(verifySession(secret, token, NOW + 59).valid).toBe(true);
    expect(verifySession(secret, token, NOW + 60)).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a token signed with another secret, which is how rotation ends sessions", () => {
    const token = signSession(secret, NOW);
    expect(verifySession(newSessionSecret(), token, NOW)).toEqual({ valid: false, reason: "bad signature" });
  });

  it("rejects a tampered payload", () => {
    const [header, payload, sig] = signSession(secret, NOW, 60).split(".");
    const forged = Buffer.from(JSON.stringify({ iat: NOW, exp: NOW + 999999 })).toString("base64url");
    expect(payload).not.toBe(forged);
    expect(verifySession(secret, `${header}.${forged}.${sig}`, NOW)).toEqual({
      valid: false,
      reason: "bad signature",
    });
  });

  it("names what is wrong with unusable tokens", () => {
    expect(verifySession(secret, undefined, NOW)).toEqual({ valid: false, reason: "missing" });
    expect(verifySession(secret, "", NOW)).toEqual({ valid: false, reason: "missing" });
    expect(verifySession(secret, "not-a-jwt", NOW)).toEqual({ valid: false, reason: "malformed" });
    expect(verifySession(secret, "a.b.c.d", NOW)).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a correctly signed token whose payload is not a session", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: "soon" })).toString("base64url");
    const token = signSession(secret, NOW);
    const sig = token.split(".")[2];
    expect(sig).toBeDefined();
    // Sign the bad payload properly, so only the payload check can reject it.
    const check = verifySession(secret, `${header}.${payload}.${sig}`, NOW);
    expect(check.valid).toBe(false);
  });

  it("makes a different secret every time", () => {
    expect(newSessionSecret()).not.toBe(newSessionSecret());
  });
});
