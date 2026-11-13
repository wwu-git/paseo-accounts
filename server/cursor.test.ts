import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorAdapter, assertCursorLaunch, parseCursorStatus, parseCursorUsage } from "./cursor";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "accounts-cursor-")); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("Cursor account isolation", () => {
  it("stores only the selected key privately and clears competing auth in a spawned environment", async () => {
    const a = new CursorAdapter();
    await a.prepareHome(root);
    const login = await a.login(root, "code");
    await login.submitCode("  key-for-second-account  ");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect((await stat(join(root, "auth.json"))).mode & 0o777).toBe(0o600);
    const env = await a.env(root);
    expect(env.CURSOR_API_KEY).toBe("key-for-second-account");
    expect(env.CURSOR_AUTH_TOKEN).toBe("");
    expect(JSON.stringify(await a.identity(root))).not.toContain("key-for-second-account");
    await a.logout(root);
    await expect(a.env(root)).rejects.toThrow(/credential/i);
  });
  it("cannot save a key after cancellation", async () => {
    const a = new CursorAdapter();
    const login = await a.login(root, "code");
    login.cancel();
    await expect(login.submitCode("do-not-save")).rejects.toThrow(/expired|cancel/i);
    await expect(readFile(join(root, "auth.json"))).rejects.toThrow();
  });
  it("does not borrow the global login to query a managed API key account", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const a = new CursorAdapter();
    await a.prepareHome(root);
    const login = await a.login(root, "code"); await login.submitCode("my-key");
    expect((await a.usage(root)).error).toMatch(/API key|login/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Cursor launch boundaries", () => {
  it("accepts the installed native ACP command", () => {
    expect(() => assertCursorLaunch({ command: "cursor-agent", prefix: ["acp"] }, {})).not.toThrow();
  });
  it.each([["--api-key=secret"], ["--auth-token", "secret"], ["-ehttps://example.org"], ["--endpoint", "https://example.org"], ["acp", "--insecure"]])("rejects unsupported command args without echoing secrets: %j", (...prefix: string[]) => {
    expect(() => assertCursorLaunch({ command: "agent", prefix }, {})).toThrow(/Cursor.*config/i);
    try { assertCursorLaunch({ command: "agent", prefix }, {}); } catch (e) { expect(String(e)).not.toContain("secret"); }
  });
  it("rejects wrappers and custom inherited endpoints", () => {
    expect(() => assertCursorLaunch({ command: "bash", prefix: [] }, {})).toThrow();
    expect(() => assertCursorLaunch({ command: "agent", prefix: [] }, { CURSOR_API_ENDPOINT: "http://127.0.0.1:8888" })).toThrow();
  });
});

it("reads only documented status fields, never returning tokens", () => {
  const status = parseCursorStatus({ isAuthenticated: true, userInfo: { email: "a@example.org", sub: "user-a" }, accessToken: "secret" });
  expect(status).toMatchObject({ signedIn: true, email: "a@example.org" });
  expect(JSON.stringify(status)).not.toContain("secret");
  expect(parseCursorStatus({ status: "unknown" }).signedIn).toBe(false);
});

it("keeps Cursor pools display-only and billing dates separate from quota resets", () => {
  const usage = parseCursorUsage({ planUsage: { totalPercentUsed: 105, autoPercentUsed: 30, apiPercentUsed: 100 }, billingCycleEnd: 1800000000 });
  expect(usage.windows.map(w => w.usedPercent)).toEqual([105, 30, 100]);
  expect(usage.windows.every(w => w.resetsAt === null)).toBe(true);
  expect(usage.routingEligible).toBe(false);
});

it("represents amount-only quota as plan balance, not extra usage or invented percentages", () => {
  const usage = parseCursorUsage({ planUsage: { totalSpend: 2500, limit: 2000, remaining: 400 }, billingCycleEnd: 1800000000 });
  expect(usage.windows).toEqual([]);
  expect(usage.balances?.[0]).toMatchObject({ usedMinor: 2500, limitMinor: 2000, remainingMinor: 400, exponent: 2, currency: "USD" });
  expect(usage.extra).toBeUndefined();
});

it("only classifies explicit Cursor quota/auth codes, not capacity or agent-store errors", () => {
  const a = new CursorAdapter();
  const event = (code: string, message = "request failed") => ({ outcome: { kind: "failed" as const, error: { code, message } }, timeline: [] });
  expect(a.detectLimit(event("PRO_USER_USAGE_LIMIT"))?.kind).toBe("budget");
  expect(a.detectLimit(event("FREE_USER_USAGE_LIMIT"))).not.toBeNull();
  expect(a.detectLimit(event("RESOURCE_EXHAUSTED", "Agent-store quota exceeded"))).toBeNull();
  expect(a.detectLimit(event("RATE_LIMITED"))).toBeNull();
  expect(a.detectSignOut(event("UNAUTHENTICATED"))).toBeTruthy();
});

it("leaves self-authenticated and custom Cursor profiles outside account routing", async () => {
  const { familiesFromConfig } = await import("./families");
  expect(familiesFromConfig({ cursor: { command: ["cursor-agent", "acp"], env: {} } }).cursor).toBe("cursor");
  expect(familiesFromConfig({ cursor: { command: ["agent", "--api-key=secret", "acp"] } }).cursor).toBeUndefined();
  expect(familiesFromConfig({ custom: { extends: "cursor", env: { CURSOR_API_ENDPOINT: "https://example.org" } } }).custom).toBeUndefined();
});
