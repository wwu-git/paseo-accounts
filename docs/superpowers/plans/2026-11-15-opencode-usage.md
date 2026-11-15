# OpenCode usage implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show OpenCode Console Go allowance through the existing Accounts interface.
**Architecture:** Read the local CLI API; validate its envelope; convert three meters into UsageRead. Keep readings display-only and scoped to their Console source.
**Tech Stack:** Existing TypeScript, Zod, Vitest and React Native.
**Spec:** `docs/superpowers/specs/2026-11-15-opencode-usage-design.md`

## Global constraints

- No secret export, database reads, new dependencies, remote writes or daemon restart.
- CLI timeout 20 seconds; refresh spacing 60 seconds; display validity 5 minutes.
- routingEligible=false until account binding is established.

## Review focus

- Null response must not mean zero usage or signed-out model credentials.
- Console workspace readings must identify their source and never control Go Key routing.
- Source changes and failed reads must not retain an unrelated account's windows.
- Unknown fields are tolerated; malformed required fields are rejected without raw-output errors.
- Legacy managed accounts must never inherit native Console usage.

## Task 1: Adapter

- [x] Add failing `server/opencode.test.ts` cases for valid three-window conversion, null/no Go, malformed values, CLI failure and legacy/home isolation.
- [x] Implement `OpenCodeAdapter.usage(home: string | null): Promise<UsageRead>` using local API; test via `npx vitest run server/opencode.test.ts`.

## Task 2: Scoped display

- [x] Add optional sourceId/sourceLabel to UsageSchema; add source-change and scoped-error regression tests in server/usage.test.ts.
- [x] Update mergeUsage to invalidate source changes, preserve only same-source cached errors, and show sourceLabel in account details.
- [x] Update README with Console login, display-only behavior and failure handling. Commit tested feature with spec and plan.

## Task 3: Acceptance

- [x] Run npm test, npm run typecheck and git diff --check; review final changes.
- [x] Reload exact local plugin, verify ready/usage RPC and authentic CLI result; inspect desktop/mobile preview if available.
- [x] Record real-data validation or explicit pending device authorization. Do not push or merge.

## Execution and validation record

- Implemented in an isolated development worktree. Tests first failed (13 assertions), then passed; full suite initially 242/242.
- One independent read-only review identified two important gaps: model limit inference could modify Console percentages, and native Paseo Usage omitted attribution. Added regressions which failed, then guarded `showLimit` and cooldown derivation through `routingUsage`, and added source/scope details to native reports. Full final suite 245/245, typecheck and diff whitespace check passed.
- Ruling: if a failed query cannot establish the current Console source, discard its old windows instead of retaining unattributable data. Temporary blank usage is preferable to cross-account attribution; existing unscoped provider behavior is preserved.
- Installed runtime `paseo-accounts` reloaded from this worktree, status running. Live adapter and plugin RPC return empty windows with the Console login instruction, while the Go model account remains ready.
- Headless Chrome preview: 1100px/light and 390px/dark show all three fixture windows and source label without horizontal overflow. These screenshots validate layout with synthetic data, not live subscription amounts. Remote Paseo browser host timed out, so the local preview was checked in a separate temporary browser profile.
- Live acceptance: Console OAuth completed successfully. The live adapter and installed plugin RPC independently returned identical, fresh readings for all three Go windows without errors. The Go model account stayed ready. Account identifiers, exact subscription usage and reset timestamps are intentionally excluded from this public record. This supersedes the earlier signed-out probe above.
- Remaining coverage limits: manual comparison with the official dashboard and machine verification that the Console member matches the separate Go model key are not performed. Routing remains disabled for these readings. No remote push/merge performed.
