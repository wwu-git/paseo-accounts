import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./process";
import { OpenCodeAdapter } from "./opencode";

vi.mock("./process", async (load) => ({ ...(await load<typeof import("./process")>()), run: vi.fn() }));

describe("OpenCode Go accounts", () => {
  beforeEach(() => { vi.mocked(run).mockReset(); vi.mocked(run).mockResolvedValue({ code: 0, stdout: "1.5.0", stderr: "", timedOut: false }); });
  const saved = process.env.XDG_DATA_HOME;
  let root: string | null = null;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("signs in with a pasted key and layers it over the user's other sign-ins", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-opencode-"));
    process.env.XDG_DATA_HOME = join(root, "data");
    mkdirSync(join(root, "data", "opencode"), { recursive: true });
    writeFileSync(join(root, "data", "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "main" }, other: { type: "api", key: "x" } }));
    const home = join(root, "home");
    const adapter = new OpenCodeAdapter();
    await adapter.prepareHome(home);

    const login = await adapter.login(home, "code");
    expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://opencode.ai/auth" });
    await login.submitCode("second");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);

    const env = await adapter.env(home);
    expect(JSON.parse(env.OPENCODE_AUTH_CONTENT!)).toEqual({ "opencode-go": { type: "api", key: "second" }, other: { type: "api", key: "x" } });
    expect(await adapter.env(null)).toEqual({ OPENCODE_AUTH_CONTENT: null });

    const [main, added] = [await adapter.identity(null), await adapter.identity(home)];
    expect(main.signedIn && added.signedIn).toBe(true);
    expect(main.identity).not.toBe(added.identity);
    expect(added.identity).not.toContain("second");
  });

  function native(connections: unknown[], failed = false) {
    vi.mocked(run).mockImplementation(async (_command, args) => ({ code: failed && args[0] === "auth" ? 1 : 0,
      stdout: args[0] === "--version" ? "opencode v2.3.0" : JSON.stringify([{id:"opencode-go",connections}]), stderr:"",timedOut:false }));
  }

  it("recognises v2 CLI credentials without reading a legacy auth.json", async () => {
    native([{type:"credential",id:"conn-a",label:"One",method:"key"},{type:"credential",id:"conn-b",label:"Two",method:"key"}]);
    const identity=await new OpenCodeAdapter().identity(null);
    expect(identity).toMatchObject({signedIn:true,plan:"Go"});
    expect(identity.identity).toMatch(/^opencode-native\|/);
    expect(vi.mocked(run).mock.calls.some(([,args]) => args.join(" ") === "auth list --format json")).toBe(true);
    expect(vi.mocked(run).mock.calls.some(([,args]) => args.includes("export"))).toBe(false);
  });

  it("acknowledges an externally completed CLI login instead of asking to log in again", async () => {
    native([{type:"credential",id:"conn-a",label:"One",method:"key"}]);
    const login=await new OpenCodeAdapter().login(null,"code");
    expect(await login.finished).toEqual({ok:true,message:null});
  });

  it("does not treat non-credential entries or empty connections as signed in", async () => {
    native([{type:"env",id:"env-a"},{type:"credential",id:""}]);
    expect((await new OpenCodeAdapter().identity(null)).signedIn).toBe(false);
  });

  it("preserves the prior identity on transient CLI metadata failures", async () => {
    native([],true);
    await expect(new OpenCodeAdapter().identity(null)).rejects.toThrow(/Could not read/);
  });

  it("does not apply v1 credential overlays to the v2 native store", async () => {
    native([]);
    const adapter=new OpenCodeAdapter();
    await expect(adapter.login("/unused","code")).rejects.toThrow(/OpenCode 2/);
    await expect(adapter.env("/unused")).rejects.toThrow(/OpenCode 2/);
  });

  function usageResponse(data: unknown, code = 0, timedOut = false) {
    vi.mocked(run).mockImplementation(async (_command, args) => ({ code: args[1] === "experimental.usage.limits" ? code : 0,
      stdout: args[0] === "--version" ? "opencode v2.3.0" : args.includes("integration.get")
        ? JSON.stringify({data:{id:"opencode",connections:[{type:"credential",id:"console-a"}]}})
        : JSON.stringify({location:{directory:"/project"},data}),
      stderr: "secret output must not escape", timedOut }));
  }
  const meter = { percent: 24, limited: false, resetsAt: Date.parse("2026-12-01T00:00:00Z") };
  const allowance = () => ({ workspace:{id:"wrk-one",name:"Personal"}, go:{rolling:meter,weekly:{...meter,percent:7},monthly:{...meter,percent:101,limited:true}},budgets:[] });

  it("reads native Console allowance as three display-only windows with source attribution", async () => {
    usageResponse(allowance());
    const usage = await new OpenCodeAdapter().usage(null);
    expect(usage).toMatchObject({error:null,cached:false,routingEligible:false,sourceLabel:"OpenCode Console · Personal (wrk-one)",resets:null});
    expect(usage.windows).toEqual([
      {id:"five_hour",label:"5-hour",usedPercent:24,resetsAt:"2026-12-01T00:00:00.000Z"},
      {id:"seven_day",label:"Weekly",usedPercent:7,resetsAt:"2026-12-01T00:00:00.000Z"},
      {id:"monthly",label:"Monthly",usedPercent:101,resetsAt:"2026-12-01T00:00:00.000Z"},
    ]);
    expect(Date.parse(usage.validUntil!) - Date.parse(usage.fetchedAt)).toBe(300_000);
    expect(usage.sourceId).toMatch(/^opencode-console\|/);
    expect(vi.mocked(run).mock.calls.some(([,args,options]) => args.join(" ") === "api experimental.usage.limits" && options?.timeoutMs === 20_000)).toBe(true);
  });

  it("distinguishes missing Console sign-in from model authentication", async () => {
    usageResponse(null);
    expect(await new OpenCodeAdapter().usage(null)).toMatchObject({windows:[],routingEligible:false,error:expect.stringContaining("opencode auth login opencode")});
  });

  it("does not invent zero usage when Console has no Go allowance", async () => {
    usageResponse({workspace:{id:"wrk-one"},budgets:[]});
    expect(await new OpenCodeAdapter().usage(null)).toMatchObject({windows:[],error:expect.stringContaining("no Go allowance")});
  });

  it.each([
    { ...meter, percent:-1 }, { ...meter, percent:"24" },
    { ...meter, resetsAt:1e30 }, { ...meter, limited:"no" },
  ])("rejects malformed meters without leaking CLI output: %j", async (invalid) => {
    const data=allowance(); data.go.rolling=invalid as typeof meter;
    usageResponse(data);
    const usage=await new OpenCodeAdapter().usage(null);
    expect(usage.windows).toEqual([]);
    expect(usage.error).toMatch(/invalid/i);
    expect(usage.error).not.toContain("secret");
  });

  it("isolates workspace and location sources", async () => {
    usageResponse(allowance());
    const a=await new OpenCodeAdapter().usage(null);
    usageResponse({...allowance(),workspace:{id:"wrk-two",name:"Other"}});
    const b=await new OpenCodeAdapter().usage(null);
    expect(a.sourceId).not.toBe(b.sourceId);
    const original=vi.mocked(run).getMockImplementation()!;
    vi.mocked(run).mockImplementation(async (...args) => {
      const result=await original(...args);
      if (args[1].includes("experimental.usage.limits")) {
        const body=JSON.parse(result.stdout); body.location.directory="/other"; result.stdout=JSON.stringify(body);
      }
      return result;
    });
    expect((await new OpenCodeAdapter().usage(null)).sourceId).not.toBe(b.sourceId);
  });

  it("discards a reading when Console connections change during the request", async () => {
    usageResponse(allowance());
    const original=vi.mocked(run).getMockImplementation()!;
    let metadataReads=0;
    vi.mocked(run).mockImplementation(async (...args) => {
      const result=await original(...args);
      if (args[1].includes("integration.get") && ++metadataReads > 1) {
        result.stdout=JSON.stringify({data:{id:"opencode",connections:[{type:"credential",id:"console-other"}]}});
      }
      return result;
    });
    expect(await new OpenCodeAdapter().usage(null)).toMatchObject({windows:[],error:expect.stringContaining("changed during")});
  });

  it("handles non-JSON CLI output without displaying it", async () => {
    usageResponse(allowance());
    const original=vi.mocked(run).getMockImplementation()!;
    vi.mocked(run).mockImplementation(async (...args) => {
      const result=await original(...args);
      if (args[1].includes("experimental.usage.limits")) result.stdout="not JSON secret";
      return result;
    });
    const usage=await new OpenCodeAdapter().usage(null);
    expect(usage.error).toMatch(/invalid/i);
    expect(usage.error).not.toContain("secret");
    expect(usage.windows).toEqual([]);
  });

  it.each([false,true])("reports CLI failures without exposing output (timeout %s)", async (timeout) => {
    usageResponse(null,1,timeout);
    const usage=await new OpenCodeAdapter().usage(null);
    expect(usage.windows).toEqual([]);
    expect(usage.error).toMatch(timeout ? /timed out/i : /unavailable/i);
    expect(usage.error).not.toContain("secret");
  });

  it("does not query native Console allowance for legacy or managed credentials", async () => {
    expect((await new OpenCodeAdapter().usage(null)).error).toMatch(/OpenCode 2/);
    native([]);
    expect((await new OpenCodeAdapter().usage("/managed")).windows).toEqual([]);
    expect(vi.mocked(run).mock.calls.some(([,args]) => args[0] === "api")).toBe(false);
  });

  it("retries integration.get when OpenCode cold-boots an evicted location (initial 404)", async () => {
    usageResponse(allowance());
    const original = vi.mocked(run).getMockImplementation()!;
    let integrationAttempts = 0;
    vi.mocked(run).mockImplementation(async (...args) => {
      if (args[1].includes("integration.get") && ++integrationAttempts <= 2) {
        return { code: 1, stdout: "", stderr: "HTTP 404 Not Found", timedOut: false };
      }
      return original(...args);
    });
    const usage = await new OpenCodeAdapter(0).usage(null);
    expect(usage.error).toBeNull();
    expect(usage.windows).toHaveLength(3);
    expect(integrationAttempts).toBe(4);
  });

});
