import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { LoginMethod, Usage } from "../shared/model";
import { ProgressEmitter, spawnEnv, type EnvPatch, type FamilyAdapter, type Identity, type LoginHandle, type RedeemReply, type TurnEvent, type UsageRead } from "./adapter";
import { providerCommand, type Command } from "./binaries";
import { writeJsonAtomic } from "./json-file";
import { run } from "./process";

const ENDPOINT = "https://api2.cursor.sh";
const KEY_PAGE = "https://cursor.com/dashboard?tab=integrations";
const FRESH_MS = 5 * 60_000;
const unsigned = (): Identity => ({ signedIn: false, email: null, plan: null, organization: null, identity: null });

/** Fail closed before a managed secret reaches command arguments or an unverified endpoint. */
export function assertCursorLaunch(command: Command, env: NodeJS.ProcessEnv): void {
  if (!["agent", "cursor-agent", "agent.exe", "cursor-agent.exe"].includes(basename(command.command)) ||
      command.prefix.some((arg) => arg !== "acp") || command.prefix.length > 1 ||
      (env.CURSOR_API_ENDPOINT && env.CURSOR_API_ENDPOINT.replace(/\/$/, "") !== ENDPOINT) ||
      env.CURSOR_API_BASE_URL || env.CURSOR_BACKEND_URL || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Cursor launch configuration is not supported for managed accounts. Use the native CLI and its official endpoint.");
  }
}

async function keyAt(home: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    return typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey : null;
  } catch { return null; }
}

export function parseCursorStatus(raw: unknown): Identity {
  if (!raw || typeof raw !== "object") return unsigned();
  const r = raw as Record<string, unknown>;
  if (r.isAuthenticated !== true) return unsigned();
  const user = r.userInfo && typeof r.userInfo === "object" ? r.userInfo as Record<string, unknown> : {};
  const email = typeof user.email === "string" ? user.email : null;
  const id = typeof user.userId === "string" ? user.userId : typeof user.sub === "string" ? user.sub : email;
  return { ...unsigned(), signedIn: true, email, identity: id ? `cursor|${id}` : null };
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Pools are informational until their account-wide routing meaning is proven. */
export function parseCursorUsage(raw: unknown, now = Date.now()): Usage {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const p = body.planUsage && typeof body.planUsage === "object" ? body.planUsage as Record<string, unknown> : {};
  const windows = ([
    ["plan_usage", "Total", p.totalPercentUsed], ["cursor_usage", "Cursor", p.autoPercentUsed], ["third_party_usage", "Third Party", p.apiPercentUsed],
  ] as const).flatMap(([id, label, value]) => { const usedPercent = number(value); return usedPercent === null ? [] : [{ id, label, usedPercent, resetsAt: null }]; });
  const usedMinor = number(p.totalSpend), limitMinor = number(p.limit), remainingMinor = number(p.remaining);
  const balances = [usedMinor, limitMinor, remainingMinor].some(v => v !== null)
    ? [{ id: "plan_usage", label: "Plan usage", usedMinor, limitMinor, remainingMinor, currency: "USD", exponent: 2 }] : [];
  return { fetchedAt: new Date(now).toISOString(), validUntil: new Date(now + FRESH_MS).toISOString(), routingEligible: false,
    windows, balances, error: windows.length || balances.length ? null : "Cursor returned no usage data.", cached: false, resets: null };
}

/** The CLI file only; never fall back to Cursor IDE or another account's auth store. */
function mainAuthPath(): string | null {
  if (process.platform !== "linux" || process.env.AGENT_CLI_CREDENTIAL_STORE === "memory") return null;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cursor", "auth.json");
}

export class CursorAdapter implements FamilyAdapter {
  readonly family = "cursor" as const;
  readonly portable = false; // No verified cross-account session/load guarantee.
  readonly usageSpacingMs = 60_000;

  async available() {
    try {
      const command = await providerCommand("cursor"); assertCursorLaunch(command, process.env);
      const result = await run(command.command, ["--version"], { timeoutMs: 15_000 });
      return { ok: result.code === 0, detail: result.code === 0 ? null : "Cursor CLI is unavailable." };
    } catch { return { ok: false, detail: "Cursor command or endpoint configuration is not supported." }; }
  }
  async prepareHome(home: string) { await mkdir(home, { recursive: true, mode: 0o700 }); }
  async env(home: string | null): Promise<EnvPatch> {
    assertCursorLaunch(await providerCommand("cursor"), process.env);
    if (!home) return { CURSOR_API_KEY: null, CURSOR_AUTH_TOKEN: null };
    const key = await keyAt(home);
    if (!key) throw new Error("Cursor account credential is missing. Add its API key again.");
    // Empty overrides are intentional: null inherits daemon values in this framework.
    return { CURSOR_API_KEY: key, CURSOR_AUTH_TOKEN: "", CURSOR_API_ENDPOINT: ENDPOINT };
  }
  async identity(home: string | null): Promise<Identity> {
    if (home) {
      const key = await keyAt(home);
      return key ? { ...unsigned(), signedIn: true, identity: `cursor-key|${createHash("sha256").update(key).digest("hex")}` } : unsigned();
    }
    try {
      const { command } = await providerCommand("cursor");
      const env = spawnEnv(await this.env(null));
      const result = await run(command, ["status", "--format", "json"], { env, timeoutMs: 15_000 });
      return result.code === 0 ? parseCursorStatus(JSON.parse(result.stdout)) : unsigned();
    } catch { return unsigned(); }
  }
  async usage(home: string | null): Promise<UsageRead> {
    const unknown = (error: string): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error, cached: false, resets: null, routingEligible: false });
    if (home) return unknown("Usage needs this account's CLI login; API key accounts do not borrow the global login.");
    if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) return unknown("Usage for environment credentials is not available.");
    try {
      assertCursorLaunch(await providerCommand("cursor"), process.env);
      const path = mainAuthPath();
      if (!path) return unknown("Cursor CLI file login usage is supported on Linux only.");
      const auth = JSON.parse(await readFile(path, "utf8"));
      if (typeof auth.accessToken !== "string" || !auth.accessToken) return unknown("Cursor CLI login is unavailable.");
      const response = await fetch(`${ENDPOINT}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
        method: "POST", headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        body: "{}", redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return unknown(`Cursor usage request failed (HTTP ${response.status}).`);
      return parseCursorUsage(await response.json());
    } catch { return unknown("Could not read Cursor usage. Previous data, if shown, is stale."); }
  }
  async redeemReset(): Promise<RedeemReply> { return { outcome: "none", message: "Cursor banked resets are not supported.", left: null }; }
  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    if (!home) throw new Error("Sign in to the CLI with `agent login` in a terminal. Added accounts use a Cursor user API key.");
    return new CursorKeyLogin(home);
  }
  async logout(home: string | null): Promise<void> {
    if (!home) throw new Error("Sign out the CLI login with `agent logout` in a terminal.");
    await rm(join(home, "auth.json"), { force: true });
  }
  detectLimit(event: TurnEvent) {
    // Codes verified in the installed CLI; ordinary rate/capacity and storage quotas are excluded.
    if (event.outcome.kind !== "failed" || !["FREE_USER_USAGE_LIMIT", "PRO_USER_USAGE_LIMIT"].includes(event.outcome.error.code ?? "")) return null;
    return { kind: "budget" as const, resetsAt: null, message: "Cursor usage limit reached." };
  }
  detectSignOut(event: TurnEvent): string | null {
    return event.outcome.kind === "failed" && (event.outcome.error.code === "UNAUTHENTICATED" || /^(?:Authentication required|Not authenticated)(?:[.!]|$)/i.test(event.outcome.error.message))
      ? "Cursor authentication failed. Sign in again." : null;
  }
}

class CursorKeyLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private settle!: (value: { ok: boolean; message: string | null }) => void;
  private ended = false;
  constructor(private readonly home: string) {
    super(); this.finished = new Promise(resolve => { this.settle = resolve; });
    this.update({ step: "waiting", codeUrl: KEY_PAGE, message: "Paste a Cursor user API key. Saving it does not validate its subscription or billing." });
  }
  async submitCode(code: string): Promise<void> {
    if (this.ended) throw new Error("This sign-in is canceled or expired.");
    const apiKey = code.trim();
    if (!apiKey || apiKey.length > 8192 || /\s/.test(apiKey)) throw new Error("Paste a valid Cursor user API key.");
    this.ended = true;
    try { await writeJsonAtomic(join(this.home, "auth.json"), { apiKey }); this.settle({ ok: true, message: null }); }
    catch { this.settle({ ok: false, message: "Could not save the Cursor credential." }); throw new Error("Could not save the Cursor credential."); }
  }
  cancel(): void { if (!this.ended) { this.ended = true; this.settle({ ok: false, message: "Sign-in was canceled." }); } }
}
