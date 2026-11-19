import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { LoginMethod } from "../shared/model";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LoginHandle,
  type RedeemReply,
  type TurnEvent,
  type UsageRead,
} from "./adapter";
import { providerCommand, quietBrowserDir } from "./binaries";
import { prepareQoderHome } from "./homes";
import { writeJsonAtomic } from "./json-file";
import { run, stripAnsi } from "./process";

const PAT_PAGE = "https://qoder.com/account/integrations";
const TOKEN_KEYS = ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT", "QODER_ACCESS_TOKEN"] as const;
const unsigned = (): Identity => ({ signedIn: false, email: null, plan: null, organization: null, identity: null });

async function patAt(home: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(home, "pat.json"), "utf8")) as { token?: unknown };
    return typeof raw.token === "string" && raw.token.trim() ? raw.token : null;
  } catch {
    return null;
  }
}

/** Extracts the user UUID from a Qoder avatar URL when present, for stable account deduplication. */
function avatarUserId(avatarUrl: unknown): string | null {
  if (typeof avatarUrl !== "string") return null;
  const match = avatarUrl.match(/\/users\/([0-9a-f-]{8,})\b/i);
  return match?.[1] ?? null;
}

/** Parses `qodercli status -o json` into a plugin Identity. */
export function parseQoderStatus(raw: unknown): Identity {
  if (!raw || typeof raw !== "object") return unsigned();
  const data = raw as Record<string, unknown>;
  if (data.logged_in !== true) return unsigned();
  const email = typeof data.email === "string" && data.email.trim() ? data.email.trim() : null;
  const username = typeof data.username === "string" && data.username.trim() ? data.username.trim() : null;
  const plan = typeof data.user_type === "string" && data.user_type.trim() ? data.user_type.trim() : null;
  const stable = avatarUserId(data.avatar_url) ?? email?.toLowerCase() ?? username?.toLowerCase() ?? null;
  return {
    signedIn: true,
    email: email ?? username,
    plan,
    organization: null,
    identity: stable ? `qoder|${stable}` : null,
  };
}

/** Extracts the browser authorization URL printed by `qodercli login`. */
export function parseQoderLoginUrl(output: string): string | null {
  const match = output.match(/https:\/\/(?:[^\s"'<>]*\.)?qoder\.com\/[^\s"'<>]+/i);
  return match?.[0] ?? null;
}

/** Strips ACP transport flag from Paseo's provider command before invoking CLI subcommands. */
async function qoderCliCommand(): Promise<{ command: string; prefix: string[] }> {
  const { command, prefix } = await providerCommand("qoder");
  return { command, prefix: prefix.filter((arg) => arg !== "--acp") };
}

/**
 * Qoder CLI (`qodercli`) multi-account adapter.
 * Managed accounts get isolated `QODER_CONFIG_DIR` homes with shared settings/projects, supporting
 * both `qodercli login` (device browser flow) and Personal Access Tokens validated via `status -o json`.
 */
export class QoderAdapter implements FamilyAdapter {
  readonly family = "qoder" as const;
  readonly portable = false;
  readonly usageSpacingMs = 60_000;

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await qoderCliCommand();
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 15_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareQoderHome(home);
  }

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { QODER_CONFIG_DIR: null, QODER_PERSONAL_ACCESS_TOKEN: null };
    const pat = await patAt(home);
    const patch: EnvPatch = { QODER_CONFIG_DIR: home, QODER_PERSONAL_ACCESS_TOKEN: pat ?? "" };
    for (const key of TOKEN_KEYS) {
      if (key !== "QODER_PERSONAL_ACCESS_TOKEN" && process.env[key]) patch[key] = "";
    }
    return patch;
  }

  async identity(home: string | null): Promise<Identity> {
    const { command, prefix } = await qoderCliCommand();
    const env = spawnEnv(await this.env(home));
    const result = await run(command, [...prefix, "status", "-o", "json"], { env, timeoutMs: 15_000 });
    if (result.timedOut) throw new Error("Qoder CLI timed out while checking account status.");
    if (result.code !== 0) return unsigned();
    try {
      return parseQoderStatus(JSON.parse(result.stdout));
    } catch {
      return unsigned();
    }
  }

  async usage(): Promise<UsageRead> {
    return {
      fetchedAt: new Date().toISOString(),
      windows: [],
      error: "Qoder usage isn't shown here yet.",
      cached: false,
      resets: null,
    };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Qoder banked resets are not supported.", left: null };
  }

  async login(home: string | null, method: LoginMethod): Promise<LoginHandle> {
    if (method === "code") {
      if (!home) throw new Error("Sign in to the CLI login with the browser flow or `qodercli login` in a terminal. Personal Access Tokens are for added accounts.");
      return new QoderPatLogin(home);
    }
    const { command, prefix } = await qoderCliCommand();
    const env = spawnEnv(home ? { QODER_CONFIG_DIR: home } : {});
    // Never let a daemon-wide token override interactive sign-in.
    for (const key of TOKEN_KEYS) delete env[key];
    const quiet = await quietBrowserDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new QoderBrowserLogin(command, prefix, env, home);
  }

  async logout(home: string | null): Promise<void> {
    if (!home) throw new Error("Sign out of the Qoder CLI login with `/logout` inside `qodercli`.");
    await rm(join(home, "pat.json"), { force: true });
    await rm(join(home, ".auth"), { recursive: true, force: true });
  }

  detectLimit(_event: TurnEvent) {
    return null;
  }

  detectSignOut(_event: TurnEvent) {
    return null;
  }
}

class QoderBrowserLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(command: string, prefix: string[], env: NodeJS.ProcessEnv, home: string | null) {
    super();
    this.child = spawn(command, [...prefix, "login"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const url = parseQoderLoginUrl(this.output);
      if (url && this.progress.step === "starting") {
        this.update({ step: "waiting", url, message: "Open the link on any device to authorize Qoder CLI." });
      }
    };
    this.child.stdout.on("data", onData);
    this.child.stderr.on("data", onData);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Qoder CLI: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) {
          void (home ? rm(join(home, "pat.json"), { force: true }).catch(() => undefined) : Promise.resolve()).then(() =>
            resolve({ ok: true, message: null }),
          );
          return;
        }
        resolve({ ok: false, message: `qodercli login exited with code ${code}.` });
      });
    });
  }

  async submitCode(): Promise<void> {
    throw new Error("Finish signing in on the Qoder page, or switch to Personal Access Token sign-in.");
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }
}

class QoderPatLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private settle!: (result: { ok: boolean; message: string | null }) => void;
  private ended = false;

  constructor(private readonly home: string) {
    super();
    this.finished = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.update({
      step: "waiting",
      codeUrl: PAT_PAGE,
      message: "Create a Qoder Personal Access Token and paste it below. It will be verified before saving.",
    });
  }

  async submitCode(code: string): Promise<void> {
    if (this.ended) throw new Error("This sign-in is canceled or expired.");
    const token = code.trim();
    if (!token || token.length > 8192 || /\s/.test(token)) throw new Error("Paste a valid Qoder Personal Access Token.");
    this.update({ step: "verifying", message: "Verifying Personal Access Token…" });
    try {
      const { command, prefix } = await qoderCliCommand();
      const env = spawnEnv({ QODER_CONFIG_DIR: this.home, QODER_PERSONAL_ACCESS_TOKEN: token });
      for (const key of TOKEN_KEYS) {
        if (key !== "QODER_PERSONAL_ACCESS_TOKEN") delete env[key];
      }
      const result = await run(command, [...prefix, "status", "-o", "json"], { env, timeoutMs: 15_000 });
      if (result.timedOut) {
        this.update({ step: "waiting", message: null });
        throw new Error("Qoder token verification timed out. Try again.");
      }
      let identity = unsigned();
      if (result.code === 0) {
        try {
          identity = parseQoderStatus(JSON.parse(result.stdout));
        } catch {
          identity = unsigned();
        }
      }
      if (!identity.signedIn) {
        this.update({ step: "waiting", message: null });
        throw new Error("Qoder rejected this Personal Access Token. Check that it is active and try again.");
      }
      await writeJsonAtomic(join(this.home, "pat.json"), { token });
      await rm(join(this.home, ".auth"), { recursive: true, force: true }).catch(() => undefined);
      this.ended = true;
      this.settle({ ok: true, message: null });
    } catch (error) {
      if (this.ended) throw error;
      this.update({ step: "waiting", message: null });
      throw error instanceof Error ? error : new Error("Could not verify or save the Qoder Personal Access Token.");
    }
  }

  cancel(): void {
    if (!this.ended) {
      this.ended = true;
      this.settle({ ok: false, message: "Sign-in was canceled." });
    }
  }
}
