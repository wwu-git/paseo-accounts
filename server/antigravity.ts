import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { LoginMethod, Usage, UsageWindow } from "../shared/model";
import {
  ProgressEmitter,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LoginHandle,
  type RedeemReply,
  type TurnEvent,
  type UsageRead,
} from "./adapter";
import { providerCommand } from "./binaries";
import { run } from "./process";

const FRESH_MS = 5 * 60_000;
const SOURCE_ID = "antigravity-cli";
const SOURCE_LABEL = "Antigravity CLI";

const unsigned = (): Identity => ({ signedIn: false, email: null, plan: null, organization: null, identity: null });

const BucketSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  window: z.string().trim().optional(),
  remaining_fraction: z.number().finite().min(0).max(1),
  reset_time: z.string().nullish(),
});

const GroupSchema = z.object({
  name: z.string().trim().min(1),
  buckets: z.array(BucketSchema),
});

const CliUsageSchema = z.object({
  status: z.literal("SUCCESS"),
  command: z.object({
    name: z.literal("usage"),
    data: z.object({
      groups: z.array(GroupSchema),
    }),
  }),
});

function formatWindowName(window: string | undefined, bucketName: string): string {
  if (window === "5h") return "5-hour";
  if (window === "weekly") return "Weekly";
  return bucketName;
}

/**
 * Parses `agy --print "/usage" --output-format json` into display-only windows.
 * Each model group has independent limits, so `routingEligible` stays `false`.
 */
export function parseAntigravityUsage(raw: unknown, now = Date.now()): Usage | null {
  const parsed = CliUsageSchema.safeParse(raw);
  if (!parsed.success) return null;

  const seen = new Set<string>();
  const windows: UsageWindow[] = [];
  for (const group of parsed.data.command.data.groups) {
    for (const bucket of group.buckets) {
      if (seen.has(bucket.id)) continue;
      seen.add(bucket.id);

      let resetsAt: string | null = null;
      if (bucket.reset_time !== undefined && bucket.reset_time !== null && bucket.reset_time !== "") {
        const ms = Date.parse(bucket.reset_time);
        if (!Number.isFinite(ms)) return null;
        resetsAt = new Date(ms).toISOString();
      }

      const usedPercent = Math.round((1 - bucket.remaining_fraction) * 1000) / 10;
      windows.push({
        id: bucket.id,
        label: `${group.name} · ${formatWindowName(bucket.window, bucket.name)}`,
        usedPercent,
        resetsAt,
      });
    }
  }

  if (windows.length === 0) return null;

  return {
    fetchedAt: new Date(now).toISOString(),
    validUntil: new Date(now + FRESH_MS).toISOString(),
    routingEligible: false,
    sourceId: SOURCE_ID,
    sourceLabel: SOURCE_LABEL,
    windows,
    error: null,
    cached: false,
    resets: null,
  };
}

/**
 * Google Antigravity CLI (`agy`) read-only usage adapter.
 * Queries quota through `agy --print "/usage" --output-format json` (zero token consumption,
 * no credential export, and no internal HTTP calls).
 */
export class AntigravityAdapter implements FamilyAdapter {
  readonly family = "antigravity" as const;
  readonly portable = false;
  readonly usageSpacingMs = 60_000;

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("antigravity");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 15_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(home: string): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
  }

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return {};
    throw new Error("Google Antigravity manages accounts in its CLI. Additional accounts are not supported here.");
  }

  async identity(home: string | null): Promise<Identity> {
    if (home) return unsigned();
    const { command, prefix } = await providerCommand("antigravity");
    const result = await run(
      command,
      [...prefix, "--print", "/usage", "--output-format", "json", "--print-timeout", "15s"],
      { timeoutMs: 20_000 },
    );
    if (result.timedOut) throw new Error("Antigravity CLI timed out while checking login status.");
    if (result.code !== 0) return unsigned();
    let parsed: Usage | null = null;
    try {
      parsed = parseAntigravityUsage(JSON.parse(result.stdout));
    } catch {
      return unsigned();
    }
    if (!parsed) return unsigned();
    return { signedIn: true, email: null, plan: null, organization: null, identity: SOURCE_ID };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const empty = (error: string): UsageRead => ({
      fetchedAt,
      windows: [],
      error,
      cached: false,
      resets: null,
      routingEligible: false,
      sourceId: SOURCE_ID,
      sourceLabel: SOURCE_LABEL,
    });
    if (home) return empty("Antigravity usage is available only for the CLI login.");
    try {
      const { command, prefix } = await providerCommand("antigravity");
      const result = await run(
        command,
        [...prefix, "--print", "/usage", "--output-format", "json", "--print-timeout", "15s"],
        { timeoutMs: 20_000 },
      );
      if (result.timedOut) return empty("Antigravity usage query timed out. Try refreshing again.");
      if (result.code !== 0) return empty("Antigravity usage is unavailable. Sign in with `agy` and try refreshing again.");
      const parsed = parseAntigravityUsage(JSON.parse(result.stdout));
      if (!parsed) return empty("Antigravity CLI returned invalid or empty usage data.");
      return parsed;
    } catch {
      // Never expose raw CLI output or parser details to UI/logs.
      return empty("Antigravity usage is unavailable or returned invalid data. Refresh to try again.");
    }
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Google Antigravity banked resets are not supported.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    if (!home) {
      if ((await this.identity(null)).signedIn) return new AntigravityConnected();
      throw new Error("No Google Antigravity CLI login detected. Sign in with `agy` in a terminal, then refresh Accounts.");
    }
    throw new Error("Google Antigravity manages accounts in its CLI. Additional accounts are not supported here.");
  }

  async logout(_home: string | null): Promise<void> {
    throw new Error("Sign out of Google Antigravity in the `agy` CLI.");
  }

  detectLimit(_event: TurnEvent) {
    return null;
  }

  detectSignOut(_event: TurnEvent) {
    return null;
  }
}

class AntigravityConnected extends ProgressEmitter implements LoginHandle {
  readonly finished = Promise.resolve({ ok: true, message: null });

  constructor() {
    super();
    this.update({ step: "done" });
  }

  async submitCode(): Promise<void> {
    throw new Error("The CLI login is already connected.");
  }

  cancel(): void {
    // Already completed.
  }
}
