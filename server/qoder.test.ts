import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { run } from "./process";
import { parseQoderLoginUrl, parseQoderStatus, parseQoderUsage, QoderAdapter } from "./qoder";

vi.mock("./process", async (load) => ({ ...(await load<typeof import("./process")>()), run: vi.fn() }));
vi.mock("node:child_process", async (load) => ({ ...(await load<typeof import("node:child_process")>()), spawn: vi.fn() }));

const SAMPLE_STATUS = {
  logged_in: true,
  version: "1.1.92",
  allow_byok: 0,
  auth_source: "local",
  account_type: "user",
  login_method: "browser",
  username: "Alice",
  email: "alice@example.com",
  avatar_url: "https://qoder.com/users/00000000-0000-4000-8000-000000000001/default/avatars",
  user_type: "personal_standard",
};

describe("Qoder parsers", () => {
  it("parses logged-in status JSON into a stable Identity", () => {
    expect(parseQoderStatus(SAMPLE_STATUS)).toEqual({
      signedIn: true,
      email: "alice@example.com",
      plan: "personal_standard",
      organization: null,
      identity: "qoder|00000000-0000-4000-8000-000000000001",
    });
  });

  it("falls back to email when avatar_url has no user id and treats logged_in=false as signed out", () => {
    expect(parseQoderStatus({ logged_in: true, email: "Bob@Example.com", user_type: "pro" })).toEqual({
      signedIn: true,
      email: "Bob@Example.com",
      plan: "pro",
      organization: null,
      identity: "qoder|bob@example.com",
    });
    expect(parseQoderStatus({ logged_in: false })).toMatchObject({ signedIn: false, identity: null });
    expect(parseQoderStatus(null)).toMatchObject({ signedIn: false, identity: null });
  });

  it("extracts the device authorization URL from qodercli login output", () => {
    const output = `Starting browser login...\n\nPlease open the following URL in your browser to sign in:\n\n  https://qoder.com/device/selectAccounts?challenge=abc&nonce=123\n\nWaiting for browser authorization...\n`;
    expect(parseQoderLoginUrl(output)).toBe("https://qoder.com/device/selectAccounts?challenge=abc&nonce=123");
    expect(parseQoderLoginUrl("Starting browser login...")).toBeNull();
  });
});

describe("QoderAdapter", () => {
  const savedConfigDir = process.env.QODER_CONFIG_DIR;
  const savedPat = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  const savedPaseoHome = process.env.PASEO_HOME;
  let root: string | null = null;
  let paseoTmp: string | null = null;

  beforeEach(() => {
    vi.mocked(run).mockReset();
    vi.mocked(spawn).mockReset();
    paseoTmp = mkdtempSync(join(tmpdir(), "paseo-accounts-qoder-paseo-"));
    process.env.PASEO_HOME = paseoTmp;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.QODER_CONFIG_DIR;
    else process.env.QODER_CONFIG_DIR = savedConfigDir;
    if (savedPat === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = savedPat;
    if (savedPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedPaseoHome;
    if (root) rmSync(root, { recursive: true, force: true });
    if (paseoTmp) rmSync(paseoTmp, { recursive: true, force: true });
    root = null;
    paseoTmp = null;
  });

  it("checks CLI availability with qodercli --version and strips --acp from configured commands", async () => {
    vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout: "1.1.92\n", stderr: "", timedOut: false });
    await expect(new QoderAdapter().available()).resolves.toEqual({ ok: true, detail: null });
    expect(vi.mocked(run)).toHaveBeenCalledWith("qodercli", ["--version"], { timeoutMs: 15_000 });
  });

  it("prepares an isolated home that shares settings and projects while keeping auth private", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-qoder-"));
    const main = join(root, "main");
    const home = join(root, "managed");
    mkdirSync(join(main, ".auth"), { recursive: true });
    mkdirSync(join(main, "plugins"), { recursive: true });
    mkdirSync(join(main, "projects"), { recursive: true });
    writeFileSync(join(main, "settings.json"), '{"theme":"dark"}');
    writeFileSync(join(main, ".auth", "cred.json"), '{"secret":"main"}');
    writeFileSync(join(main, "state.json"), '{"id":1}');
    process.env.QODER_CONFIG_DIR = main;

    const adapter = new QoderAdapter();
    await adapter.prepareHome(home);

    expect(lstatSync(join(home, "settings.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, "plugins")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".auth"))).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(false);
  });

  it("isolates managed browser homes from a daemon-wide PAT and injects saved PATs", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-qoder-"));
    const home = join(root, "managed");
    mkdirSync(home, { recursive: true });
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "global-token";

    const adapter = new QoderAdapter();
    expect(await adapter.env(null)).toEqual({ QODER_CONFIG_DIR: null, QODER_PERSONAL_ACCESS_TOKEN: null });
    expect(await adapter.env(home)).toEqual({ QODER_CONFIG_DIR: home, QODER_PERSONAL_ACCESS_TOKEN: "" });

    writeFileSync(join(home, "pat.json"), JSON.stringify({ token: "acct-pat" }), { mode: 0o600 });
    expect(await adapter.env(home)).toEqual({ QODER_CONFIG_DIR: home, QODER_PERSONAL_ACCESS_TOKEN: "acct-pat" });
  });

  it("verifies PATs via qodercli status -o json before saving with mode 0600", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-qoder-"));
    const home = join(root, "managed");
    mkdirSync(join(home, ".auth"), { recursive: true });
    writeFileSync(join(home, ".auth", "old.json"), "{}");

    const adapter = new QoderAdapter();
    const login = await adapter.login(home, "code");
    expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://qoder.com/account/integrations" });

    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "rejected token", timedOut: false });
    await expect(login.submitCode("bad-pat")).rejects.toThrow(/rejected/i);
    expect(existsSync(join(home, "pat.json"))).toBe(false);

    vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(SAMPLE_STATUS), stderr: "", timedOut: false });
    await login.submitCode("good-pat-123");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(statSync(join(home, "pat.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, ".auth"))).toBe(false);

    await adapter.logout(home);
    expect(existsSync(join(home, "pat.json"))).toBe(false);
  });

  it("captures the authorization URL from qodercli login and completes on exit 0", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-qoder-"));
    const home = join(root, "managed");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "pat.json"), JSON.stringify({ token: "old" }));

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as never);

    const adapter = new QoderAdapter();
    const login = await adapter.login(home, "browser");
    const updates: string[] = [];
    login.onProgress((p) => {
      if (p.url) updates.push(p.url);
    });

    child.stdout.emit(
      "data",
      Buffer.from("Please open:\n  https://qoder.com/device/selectAccounts?challenge=xyz\nWaiting...\n"),
    );
    expect(updates).toEqual(["https://qoder.com/device/selectAccounts?challenge=xyz"]);
    expect(login.progress.step).toBe("waiting");

    child.emit("close", 0);
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(existsSync(join(home, "pat.json"))).toBe(false);
  });

  it("preserves prior identity on timeout and reads signed-in identity from status JSON", async () => {
    const adapter = new QoderAdapter();
    vi.mocked(run).mockResolvedValueOnce({ code: null, stdout: "", stderr: "", timedOut: true });
    await expect(adapter.identity(null)).rejects.toThrow(/timed out/i);

    vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(SAMPLE_STATUS), stderr: "", timedOut: false });
    expect(await adapter.identity(null)).toMatchObject({ signedIn: true, email: "alice@example.com", plan: "personal_standard" });
  });

  it("parses SDK UsageInfo into display-only credit windows and hashes userId", () => {
    const now = Date.parse("2026-11-19T06:00:00Z");
    const parsed = parseQoderUsage(
      {
        userId: "user-123",
        userType: "personal_professional",
        totalUsagePercentage: 1,
        expiresAt: 1797696000000,
        userQuota: { total: 2000, used: 0, remaining: 2000, percentage: 0, unit: "credits" },
        addOnQuota: { total: 2100, used: 43, remaining: 2057, percentage: 2, unit: "credits" },
        orgResourcePackage: { available: true, used: 50, cap: 500, percentage: 10, unit: "credits" },
      },
      now,
    );
    expect(parsed).toMatchObject({
      fetchedAt: "2026-11-19T06:00:00.000Z",
      validUntil: "2026-11-19T06:05:00.000Z",
      routingEligible: false,
      sourceLabel: "Qoder CLI",
      error: null,
      windows: [
        { id: "plan_credits", label: "Plan Credits (0/2000)", usedPercent: 0, resetsAt: "2026-12-19T16:00:00.000Z" },
        { id: "addon_credits", label: "Add-on Credits (43/2100)", usedPercent: 2, resetsAt: null },
        { id: "org_package", label: "Org Package (50/500)", usedPercent: 10, resetsAt: null },
      ],
    });
    expect(parsed?.sourceId).toMatch(/^qoder-cli\|[0-9a-f]{24}$/);
    expect(parsed?.sourceId).not.toContain("user-123");
    expect(parseQoderUsage(null)).toBeNull();
    expect(parseQoderUsage({})).toBeNull();
  });

  it("queries usage via SDK startDaemon with isolated auth and always stops the daemon", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-qoder-usage-"));
    const home = join(root, "managed");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "pat.json"), JSON.stringify({ token: "pat-secret" }), { mode: 0o600 });

    const stop = vi.fn().mockResolvedValue(undefined);
    const getUsageInfo = vi.fn().mockResolvedValue({
      userId: "u1",
      userQuota: { total: 2000, used: 100, remaining: 1900, percentage: 5, unit: "credits" },
    });
    const startDaemon = vi.fn().mockResolvedValueOnce({ getUsageInfo, stop } as never);

    const adapter = new QoderAdapter(async () => ({ startDaemon }));
    const reading = await adapter.usage(home);
    expect(reading).toMatchObject({
      error: null,
      routingEligible: false,
      windows: [{ id: "plan_credits", label: "Plan Credits (100/2000)", usedPercent: 5 }],
    });
    expect(startDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: "process",
        auth: { type: "accessToken", accessToken: "pat-secret" },
        env: expect.objectContaining({ QODER_CONFIG_DIR: home, QODER_PERSONAL_ACCESS_TOKEN: "pat-secret" }),
      }),
    );
    expect(stop).toHaveBeenCalledTimes(1);

    const stopOnError = vi.fn().mockResolvedValue(undefined);
    startDaemon.mockResolvedValueOnce({
      getUsageInfo: vi.fn().mockRejectedValue(new Error("secret-error")),
      stop: stopOnError,
    } as never);
    const failed = await adapter.usage(null);
    expect(failed.windows).toEqual([]);
    expect(failed.error).toMatch(/Could not read Qoder usage/);
    expect(failed.error).not.toContain("secret-error");
    expect(stopOnError).toHaveBeenCalledTimes(1);
  });
});
