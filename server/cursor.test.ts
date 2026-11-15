import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorAdapter, assertCursorLaunch, keyIdentity, parseCursorStatus, parseCursorUsage } from "./cursor";

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
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("memory");
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
  it("uses only a managed account's own key and temporary token to query usage", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accessToken:"temporary-second-token",refreshToken:"never-save-this"})))
      .mockResolvedValueOnce(new Response(JSON.stringify({planUsage:{totalPercentUsed:37}})));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("CURSOR_API_KEY","unrelated-parent-key");
    vi.stubEnv("CURSOR_AUTH_TOKEN","unrelated-parent-token");
    const a = new CursorAdapter();
    await a.prepareHome(root);
    const login = await a.login(root, "code"); await login.submitCode("my-key");
    const usage=await a.usage(root);
    expect(usage).toMatchObject({error:null,routingEligible:false,sourceId:expect.stringMatching(/^cursor-key\|/),windows:[{usedPercent:37}]});
    expect(fetcher.mock.calls[0]).toMatchObject(["https://api2.cursor.sh/auth/exchange_user_api_key",{method:"POST",headers:{Authorization:"Bearer my-key"},redirect:"error"}]);
    expect(fetcher.mock.calls[1]).toMatchObject(["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",{headers:{Authorization:"Bearer temporary-second-token"},redirect:"error"}]);
    expect(await readFile(join(root,"auth.json"),"utf8")).toBe('{\n  "apiKey": "my-key"\n}\n');
    expect(JSON.stringify(usage)).not.toMatch(/my-key|temporary-second-token|never-save-this/);
  });
});

describe("managed Cursor usage", () => {
  async function saved(home=root,key="test-managed-key") {
    const adapter=new CursorAdapter(); await adapter.prepareHome(home);
    const login=await adapter.login(home,"code"); await login.submitCode(key); return adapter;
  }

  it.each([401,403,429,500])("does not query usage or expose a failed exchange body (HTTP %s)",async status=>{
    const fetcher=vi.fn().mockResolvedValue(new Response("private-error-payload",{status}));vi.stubGlobal("fetch",fetcher);
    const adapter=await saved();const usage=await adapter.usage(root);
    expect(usage.error).toContain(`HTTP ${status}`);expect(usage.windows).toEqual([]);
    expect(JSON.stringify(usage)).not.toContain("private-error-payload");expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await adapter.identity(root)).signedIn).toBe(true);
  });

  it.each([null,{}, {accessToken:""},{accessToken:"bad token"},{accessToken:12}])("rejects invalid exchanged credentials without a usage request: %j",async body=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json(body));vi.stubGlobal("fetch",fetcher);
    const adapter=await saved();expect((await adapter.usage(root)).error).toMatch(/invalid/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose network error messages or persist temporary credentials",async()=>{
    const fetcher=vi.fn().mockRejectedValue(new Error("private-network-error"));vi.stubGlobal("fetch",fetcher);
    const adapter=await saved();const usage=await adapter.usage(root);
    expect(usage.error).toMatch(/Could not read/);expect(JSON.stringify(usage)).not.toContain("private-network-error");
    expect(JSON.parse(await readFile(join(root,"auth.json"),"utf8"))).toEqual({apiKey:"test-managed-key"});
  });

  it("uses independent exchanges and cache scopes for two accounts",async()=>{
    const fetcher=vi.fn(async(url:string,options:RequestInit)=>{
      const auth=(options.headers as Record<string,string>).Authorization ?? "";
      if(url.endsWith("exchange_user_api_key"))return Response.json({accessToken:auth.endsWith("test-first-key")?"first-token":"second-token"});
      return Response.json({planUsage:{totalPercentUsed:auth.endsWith("first-token")?11:72}});
    });vi.stubGlobal("fetch",fetcher);
    const second=join(root,"second");const adapter=await saved(root,"test-first-key");await saved(second,"test-second-key");
    const [first,last]=await Promise.all([adapter.usage(root),adapter.usage(second)]);
    expect(first.windows[0]?.usedPercent).toBe(11);expect(last.windows[0]?.usedPercent).toBe(72);
    expect(first.sourceId).not.toBe(last.sourceId);expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("discards an in-flight result when its API key is replaced",async()=>{
    const adapter=await saved();
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({accessToken:"first-token"})).mockImplementationOnce(async()=>{
      await writeFile(join(root,"auth.json"),JSON.stringify({apiKey:"replacement-key"}));
      return Response.json({planUsage:{totalPercentUsed:66}});
    });vi.stubGlobal("fetch",fetcher);
    const usage=await adapter.usage(root);expect(usage.windows).toEqual([]);
    expect(usage.sourceId).toBeUndefined();expect(usage.error).toMatch(/changed/);
  });

  it("does not exchange a rejected key",async()=>{
    const adapter=await saved();await adapter.rejectCredential(root,keyIdentity("test-managed-key"));
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    expect((await adapter.usage(root)).windows).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send a managed key when inherited endpoint configuration is unsafe",async()=>{
    const adapter=await saved();vi.stubEnv("CURSOR_API_ENDPOINT","https://example.org");
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    expect((await adapter.usage(root)).windows).toEqual([]);expect(fetcher).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform!=="linux")("continues to query the CLI login directly without a key exchange",async()=>{
    vi.stubEnv("XDG_CONFIG_HOME",root);vi.stubEnv("CURSOR_API_KEY","");vi.stubEnv("CURSOR_AUTH_TOKEN","");
    vi.stubEnv("AGENT_CLI_CREDENTIAL_STORE","file");
    await mkdir(join(root,"cursor"));await writeFile(join(root,"cursor","auth.json"),JSON.stringify({accessToken:"test-cli-token"}));
    const fetcher=vi.fn().mockResolvedValue(Response.json({planUsage:{totalPercentUsed:42}}));vi.stubGlobal("fetch",fetcher);
    const usage=await new CursorAdapter().usage(null);
    expect(usage).toMatchObject({error:null,sourceId:expect.stringMatching(/^cursor-cli\|/),windows:[{usedPercent:42}]});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]?.[0]).toContain("GetCurrentPeriodUsage");
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
