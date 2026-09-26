import { describe, expect, it } from "vitest";
import { clearedSessionCookie, cookieValue, SESSION_COOKIE, sessionCookie } from "./cookies";

describe("cookieValue", () => {
  it("reads a Cookie header", () => {
    expect(cookieValue("fh_session", "fh_session=abc")).toBe("abc");
    expect(cookieValue("fh_session", "other=1; fh_session=abc; last=2")).toBe("abc");
  });

  it("reads API Gateway's already-split list", () => {
    expect(cookieValue("fh_session", ["other=1", "fh_session=abc"])).toBe("abc");
  });

  it("keeps the dots in a JWT", () => {
    expect(cookieValue("fh_session", "fh_session=aa.bb.cc")).toBe("aa.bb.cc");
  });

  it("is undefined when absent, empty or unparseable", () => {
    expect(cookieValue("fh_session", undefined)).toBeUndefined();
    expect(cookieValue("fh_session", "")).toBeUndefined();
    expect(cookieValue("fh_session", "other=1")).toBeUndefined();
    expect(cookieValue("fh_session", "fh_session=")).toBeUndefined();
    expect(cookieValue("fh_session", "=nonsense")).toBeUndefined();
  });

  it("does not match a cookie whose name merely ends the same way", () => {
    expect(cookieValue("fh_session", "not_fh_session=abc")).toBeUndefined();
  });
});

describe("session cookie", () => {
  it("is not readable by page scripts and not sent cross-site", () => {
    const set = sessionCookie("token", 3600, true);
    expect(set).toContain(`${SESSION_COOKIE}=token`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=3600");
    expect(set).toContain("Secure");
  });

  it("drops Secure for the local http server", () => {
    expect(sessionCookie("token", 3600, false)).not.toContain("Secure");
  });

  it("expires immediately when cleared", () => {
    const cleared = clearedSessionCookie(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
  });

  it("round-trips through the parser", () => {
    const set = sessionCookie("aa.bb.cc", 60, true);
    const header = set.split(";")[0];
    expect(cookieValue(SESSION_COOKIE, header)).toBe("aa.bb.cc");
  });
});
