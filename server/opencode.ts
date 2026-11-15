import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LoginMethod } from "../shared/model";
import { ProgressEmitter, type EnvPatch, type FamilyAdapter, type Identity, type LoginHandle, type RedeemReply, type UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { writeJsonAtomic } from "./json-file";
import { detectApiStyleLimit, detectKimiSignOut } from "./limits";
import { mainOpenCodeData } from "./paths";
import { run } from "./process";

/** OpenCode's provider ID for the Go subscription, and where its sign-in keys come from. */
export const GO_PROVIDER = "opencode-go";
const KEY_PAGE = "https://opencode.ai/auth";

const MeterSchema = z.object({
  percent: z.number().finite().nonnegative(),
  limited: z.boolean(),
  resetsAt: z.number().finite().nonnegative().refine(value => Number.isFinite(new Date(value).getTime())),
});
const ConsoleUsageSchema = z.object({
  location: z.object({directory:z.string().min(1)}),
  data: z.object({
    workspace: z.object({id:z.string().min(1),name:z.string().optional()}),
    go: z.object({rolling:MeterSchema,weekly:MeterSchema,monthly:MeterSchema}).optional(),
  }).nullable(),
});

const ConsoleConnectionsSchema = z.object({
  data:z.object({id:z.literal("opencode"),connections:z.array(z.object({type:z.string(),id:z.string().optional()}))}),
});

type AuthFile = Record<string, unknown>;

async function readAuth(path: string): Promise<AuthFile> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as AuthFile) : {};
  } catch {
    return {};
  }
}

const mainAuthPath = () => join(mainOpenCodeData(), "auth.json");
const homeAuthPath = (home: string) => join(home, "auth.json");

function goKey(auth: AuthFile): string | null {
  const entry = auth[GO_PROVIDER] as { key?: unknown } | undefined;
  return typeof entry?.key === "string" && entry.key ? entry.key : null;
}

/**
 * An OpenCode account is a Go sign-in kept in the account's own folder. Sessions get it through
 * `OPENCODE_AUTH_CONTENT`, on top of the user's other OpenCode sign-ins, so chat history and every
 * other provider stay exactly as they are. Paseo runs a dedicated OpenCode server for such sessions.
 */
export class OpenCodeAdapter implements FamilyAdapter {
  readonly family = "opencode" as const;
  /** Chats live in OpenCode's one shared database, so they open on any account. */
  readonly portable = true;
  readonly usageSpacingMs = 60_000;
  private nativeAccounts: boolean | undefined;

  private async usesNativeAccounts(): Promise<boolean> {
    if (this.nativeAccounts !== undefined) return this.nativeAccounts;
    const { command, prefix } = await providerCommand("opencode");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error("Could not read OpenCode CLI version.");
    return (this.nativeAccounts = /(?:^|\s)v?2\./.test(result.stdout.trim()));
  }

  /** V2 exposes non-secret metadata; never export credentials or read its SQLite database. */
  private async nativeIdentity(): Promise<Identity> {
    const { command, prefix } = await providerCommand("opencode");
    const result = await run(command, [...prefix, "auth", "list", "--format", "json"], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error("Could not read OpenCode CLI connections. Try refreshing again.");
    let providers: unknown;
    try { providers = JSON.parse(result.stdout); } catch { throw new Error("Could not read OpenCode CLI connection metadata."); }
    if (!Array.isArray(providers)) throw new Error("Could not read OpenCode CLI connection metadata.");
    const connections = providers.find(p => p && typeof p === "object" && p.id === GO_PROVIDER)?.connections;
    const ids = (Array.isArray(connections) ? connections : []).flatMap(c =>
      c && typeof c === "object" && c.type === "credential" && typeof c.id === "string" && c.id.trim() ? [c.id] : []);
    if (!ids.length) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    const fingerprint = createHash("sha256").update(JSON.stringify([...new Set(ids)].sort())).digest("hex").slice(0, 16);
    return { signedIn: true, email: null, plan: "Go", organization: null, identity: `opencode-native|${fingerprint}` };
  }

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { OPENCODE_AUTH_CONTENT: null };
    if (await this.usesNativeAccounts()) throw new Error("OpenCode 2 manages connections in its CLI. Legacy per-account overlays are not supported.");
    const merged = { ...(await readAuth(mainAuthPath())), ...(await readAuth(homeAuthPath(home))) };
    return { OPENCODE_AUTH_CONTENT: JSON.stringify(merged) };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("opencode");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) { this.nativeAccounts = /(?:^|\s)v?2\./.test(result.stdout.trim()); return { ok: true, detail: null }; }
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(home: string): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
  }

  async identity(home: string | null): Promise<Identity> {
    if (await this.usesNativeAccounts()) {
      if (!home) return this.nativeIdentity();
      return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    }
    const key = goKey(await readAuth(home ? homeAuthPath(home) : mainAuthPath()));
    if (!key) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return { signedIn: true, email: null, plan: "Go", organization: null, identity: `opencode|${fingerprint}` };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const empty = (error: string): UsageRead => ({ fetchedAt, windows: [], error, cached: false, resets: null, routingEligible: false });
    // Native Console allowance cannot be attributed to a legacy managed account.
    if (home) return empty("Console usage is available only for the OpenCode 2 CLI login.");
    try {
      if (!await this.usesNativeAccounts()) return empty("Usage requires OpenCode 2 and a Console login.");
      const { command, prefix } = await providerCommand("opencode");
      // Connection IDs are public metadata. A change during the request invalidates the result.
      const connections = async () => {
        const result = await run(command, [...prefix, "api", "integration.get", "--param", "integrationID=opencode"], { timeoutMs: 20_000 });
        if (result.code !== 0) throw new Error("connections unavailable");
        const metadata = ConsoleConnectionsSchema.parse(JSON.parse(result.stdout));
        return metadata.data.connections.filter(c => c.type === "credential").map(c => c.id ?? "").sort();
      };
      const before = await connections();
      const result = await run(command, [...prefix, "api", "experimental.usage.limits"], { timeoutMs: 20_000 });
      if (result.timedOut) return empty("OpenCode Console usage query timed out. Try refreshing again.");
      if (result.code !== 0) return empty("OpenCode Console usage is unavailable. Check the CLI connection and try refreshing again.");
      const parsed = ConsoleUsageSchema.safeParse(JSON.parse(result.stdout));
      if (!parsed.success) return empty("OpenCode Console returned invalid usage data.");
      const { data, location } = parsed.data;
      if (!data) return empty("Connect the Console with `opencode auth login opencode`, then refresh usage. Your Go model login is unchanged.");
      const after = await connections();
      if (JSON.stringify(before) !== JSON.stringify(after)) return empty("OpenCode Console connections changed during the query. Refresh usage again.");
      if (!data.go) return empty("The selected Console workspace has no Go allowance available. Check its account, subscription and Usage read permission.");
      const fingerprint = createHash("sha256").update(JSON.stringify([location.directory, data.workspace.id, after])).digest("hex").slice(0, 24);
      return {
        fetchedAt, validUntil: new Date(Date.parse(fetchedAt) + 300_000).toISOString(),
        sourceId: `opencode-console|${fingerprint}`,
        sourceLabel: `OpenCode Console · ${data.workspace.name ? `${data.workspace.name} (${data.workspace.id})` : data.workspace.id}`,
        routingEligible: false, cached: false, error: null, resets: null,
        windows: ([ ["rolling","five_hour","5-hour"], ["weekly","seven_day","Weekly"], ["monthly","monthly","Monthly"] ] as const).map(([key,id,label]) => ({
          id, label, usedPercent: data.go![key].percent, resetsAt: new Date(data.go![key].resetsAt).toISOString(),
        })),
      };
    } catch {
      // CLI stderr and schema errors may contain private data. Never expose them to the UI/logs.
      return empty("OpenCode Console usage is unavailable or returned invalid data. Check the CLI connection and refresh again.");
    }
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "OpenCode Go has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    if (!home) {
      if ((await this.identity(null)).signedIn) return new OpenCodeLogin(null);
      throw new Error("No OpenCode Go CLI login detected. Connect OpenCode Go with `opencode auth login` in a terminal, then refresh Accounts.");
    }
    if (await this.usesNativeAccounts()) throw new Error("OpenCode 2 manages accounts in its CLI. Use `opencode auth login` to add a connection and `opencode auth switch` to select it.");
    return new OpenCodeLogin(home);
  }

  async logout(_home: string): Promise<void> {
    // The key lives in the home itself, which is deleted next.
  }

  detectLimit = detectApiStyleLimit;
  detectSignOut = detectKimiSignOut;
}

/** OpenCode's own `auth login` for Go: create a key on opencode.ai and paste it. */
class OpenCodeLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private settle: (result: { ok: boolean; message: string | null }) => void = () => undefined;

  constructor(private readonly home: string | null) {
    super();
    this.finished = new Promise((resolve) => (this.settle = resolve));
    if (home === null) {
      this.update({ step: "done" });
      this.settle({ ok: true, message: null });
    } else this.update({ step: "waiting", codeUrl: KEY_PAGE });
  }

  async submitCode(code: string): Promise<void> {
    if (this.home === null) throw new Error("The CLI login is already connected.");
    const key = code.trim();
    if (!key) throw new Error("Paste the key from opencode.ai.");
    await writeJsonAtomic(homeAuthPath(this.home), { [GO_PROVIDER]: { type: "api", key } });
    this.settle({ ok: true, message: null });
  }

  cancel(): void {
    this.settle({ ok: false, message: "Sign-in was canceled." });
  }
}
