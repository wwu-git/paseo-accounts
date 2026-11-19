import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAMILIES, type Family } from "../shared/model";
import { AntigravityAdapter, parseAntigravityUsage } from "./antigravity";
import type { FamilyAdapter } from "./adapter";
import { FamilyResolver } from "./families";
import { run } from "./process";
import { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore } from "./state";

vi.mock("./process", async (load) => ({ ...(await load<typeof import("./process")>()), run: vi.fn() }));

const SAMPLE_CLI_OUTPUT = {
  conversation_id: "",
  status: "SUCCESS",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9508362412452698,
              reset_time: "2026-11-26T01:42:22Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.8806537389755249,
              reset_time: "2026-11-19T06:42:22Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-26T02:29:28Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-19T07:29:28Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            {
              id: "gemini-argon-wtu-weekly",
              name: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-26T02:29:28Z",
            },
          ],
        },
      ],
    },
  },
};

describe("parseAntigravityUsage", () => {
  it("maps all groups and buckets to display-only usage windows", () => {
    const now = Date.parse("2026-11-19T02:30:00Z");
    const parsed = parseAntigravityUsage(SAMPLE_CLI_OUTPUT, now);
    expect(parsed).toMatchObject({
      fetchedAt: "2026-11-19T02:30:00.000Z",
      validUntil: "2026-11-19T02:35:00.000Z",
      routingEligible: false,
      sourceId: "antigravity-cli",
      sourceLabel: "Antigravity CLI",
      error: null,
      cached: false,
      resets: null,
      windows: [
        { id: "gemini-weekly", label: "Gemini Models · Weekly", usedPercent: 4.9, resetsAt: "2026-11-26T01:42:22.000Z" },
        { id: "gemini-5h", label: "Gemini Models · 5-hour", usedPercent: 11.9, resetsAt: "2026-11-19T06:42:22.000Z" },
        { id: "3p-weekly", label: "Claude and GPT models · Weekly", usedPercent: 0, resetsAt: "2026-11-26T02:29:28.000Z" },
        { id: "3p-5h", label: "Claude and GPT models · 5-hour", usedPercent: 0, resetsAt: "2026-11-19T07:29:28.000Z" },
        { id: "gemini-argon-wtu-weekly", label: "Gemini 4 Argon · Weekly", usedPercent: 0, resetsAt: "2026-11-26T02:29:28.000Z" },
      ],
    });
  });

  it("rejects non-usage commands, out-of-range fractions, invalid timestamps and empty buckets", () => {
    expect(parseAntigravityUsage({ ...SAMPLE_CLI_OUTPUT, status: "ERROR" })).toBeNull();
    expect(parseAntigravityUsage({ ...SAMPLE_CLI_OUTPUT, command: { name: "other", data: { groups: [] } } })).toBeNull();
    expect(
      parseAntigravityUsage({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: { groups: [{ name: "Gemini", buckets: [{ id: "g", name: "Weekly", remaining_fraction: 1.5 }] }] },
        },
      }),
    ).toBeNull();
    expect(
      parseAntigravityUsage({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: { groups: [{ name: "Gemini", buckets: [{ id: "g", name: "Weekly", remaining_fraction: 0.5, reset_time: "not-a-date" }] }] },
        },
      }),
    ).toBeNull();
    expect(parseAntigravityUsage({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } })).toBeNull();
  });
});

describe("AntigravityAdapter", () => {
  beforeEach(() => {
    vi.mocked(run).mockReset();
  });

  it("detects CLI availability via --version", async () => {
    vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout: "1.5.12\n", stderr: "", timedOut: false });
    await expect(new AntigravityAdapter().available()).resolves.toEqual({ ok: true, detail: null });
    expect(vi.mocked(run)).toHaveBeenCalledWith("agy", ["--version"], { timeoutMs: 15_000 });
  });

  it("reads usage and signed-in identity from agy --print /usage --output-format json", async () => {
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: JSON.stringify(SAMPLE_CLI_OUTPUT), stderr: "", timedOut: false });
    const adapter = new AntigravityAdapter();
    const reading = await adapter.usage(null);
    expect(reading.error).toBeNull();
    expect(reading.routingEligible).toBe(false);
    expect(reading.windows).toHaveLength(5);
    expect(vi.mocked(run)).toHaveBeenCalledWith(
      "agy",
      ["--print", "/usage", "--output-format", "json", "--print-timeout", "15s"],
      { timeoutMs: 20_000 },
    );

    const id = await adapter.identity(null);
    expect(id).toEqual({ signedIn: true, email: null, plan: null, organization: null, identity: "antigravity-cli" });
  });

  it("handles CLI timeout, non-zero exit and malformed output without leaking stderr", async () => {
    const adapter = new AntigravityAdapter();

    vi.mocked(run).mockResolvedValueOnce({ code: null, stdout: "", stderr: "secret-token", timedOut: true });
    const timedOut = await adapter.usage(null);
    expect(timedOut.windows).toEqual([]);
    expect(timedOut.error).toMatch(/timed out/i);
    expect(timedOut.error).not.toContain("secret-token");

    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "private stderr", timedOut: false });
    const failed = await adapter.usage(null);
    expect(failed.windows).toEqual([]);
    expect(failed.error).toMatch(/unavailable/i);
    expect(failed.error).not.toContain("private stderr");

    vi.mocked(run).mockResolvedValueOnce({ code: 0, stdout: "{not json", stderr: "", timedOut: false });
    const malformed = await adapter.usage(null);
    expect(malformed.windows).toEqual([]);
    expect(malformed.error).toMatch(/invalid/i);
  });

  it("preserves prior identity on timeout and rejects managed-account operations", async () => {
    const adapter = new AntigravityAdapter();
    vi.mocked(run).mockResolvedValueOnce({ code: null, stdout: "", stderr: "", timedOut: true });
    await expect(adapter.identity(null)).rejects.toThrow(/timed out/i);

    expect(await adapter.env(null)).toEqual({});
    await expect(adapter.env("/managed")).rejects.toThrow(/Additional accounts are not supported/);
    await expect(adapter.login("/managed", "code")).rejects.toThrow(/Additional accounts are not supported/);
    await expect(adapter.logout(null)).rejects.toThrow(/agy/);
    expect((await adapter.usage("/managed")).windows).toEqual([]);
  });
});

describe("Service Antigravity usage source integration", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("exposes the signed-in Antigravity CLI account in global and agent Paseo Usage scopes", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-agy-"));
    const store = new StateStore(join(root, "state.json"));
    const adapter = new AntigravityAdapter();
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: JSON.stringify(SAMPLE_CLI_OUTPUT), stderr: "", timedOut: false });

    const stub = (family: Family): FamilyAdapter => ({
      family,
      portable: false,
      usageSpacingMs: 60_000,
      available: async () => ({ ok: false, detail: null }),
      prepareHome: async () => undefined,
      env: async () => ({}),
      identity: async () => ({ signedIn: false, email: null, plan: null, organization: null, identity: null }),
      usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
      redeemReset: async () => ({ outcome: "none", message: "", left: null }),
      login: async () => {
        throw new Error("unused");
      },
      logout: async () => undefined,
      detectLimit: () => null,
      detectSignOut: () => null,
    });

    const adapters = Object.fromEntries(FAMILIES.map((f) => [f, f === "antigravity" ? adapter : stub(f)])) as Record<Family, FamilyAdapter>;
    const service = new Service(
      adapters,
      store,
      { resolve: async () => ({ antigravity: "antigravity" }) } as unknown as FamilyResolver,
      { locate: async () => null, reopen: async () => ({ ok: false, error: "unused" }) } as unknown as Reopener,
    );

    await store.update((draft) => {
      draft.accounts.push({
        id: "antigravity-main",
        family: "antigravity",
        label: "Antigravity (CLI login)",
        autoLabel: true,
        kind: "main",
        home: null,
        email: null,
        plan: null,
        organization: null,
        identity: "antigravity-cli",
        signedIn: true,
        disabled: false,
        priority: "normal",
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: "2026-11-19T00:00:00Z",
      });
    });

    const globalAccounts = await service.usageAccounts({ kind: "global" });
    expect(globalAccounts).toEqual([
      { key: "antigravity-main", label: "Antigravity (CLI login)", harness: "Antigravity", input: { accountId: "antigravity-main" } },
    ]);

    const sessionAccounts = await service.usageAccounts({ kind: "session", provider: "antigravity", env: {} });
    expect(sessionAccounts).toEqual(globalAccounts);

    await service.refreshUsage("antigravity-main", true);
    const report = await service.usageReportFor("antigravity-main");
    expect(report).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({ id: "gemini-weekly", shortLabel: "Gem wk", summary: true }),
        expect.objectContaining({ id: "gemini-5h", shortLabel: "Gem 5h", summary: true }),
        expect.objectContaining({ id: "3p-weekly", shortLabel: "3P wk", summary: true }),
        expect.objectContaining({ id: "3p-5h", shortLabel: "3P 5h", summary: true }),
        expect.objectContaining({ id: "gemini-argon-wtu-weekly", shortLabel: "Argon wk", summary: true }),
      ]),
    });
  });
});
