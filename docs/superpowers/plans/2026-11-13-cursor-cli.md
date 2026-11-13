# Cursor CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement documented Cursor account support and install the verified plugin on dev-ubuntu.
**Architecture:** Reuse FamilyAdapter, routing, non-portable continuation and existing RPC. Keep credentials scoped to one process/account; conditional usage is display-only until account-wide pool semantics are verified.
**Tech Stack:** TypeScript, React Native, Zod, Vitest, Paseo 0.15.4, Cursor CLI.
**Spec:** docs/cursor-cli-feasibility.zh-CN.md

## Global Constraints

- Only this repository and local installation are authorized; no upstream PR, push or main merge.
- Reuse this task's isolated worktree, baseline 391145bd4c8256fa213c3208f134e51fd0c82be0.
- Never print credentials or send them to custom endpoints; leave unrelated providers unchanged.
- Browser multi-login and portable session mode require actual validation; default to API keys and non-portable continuation.

## Review Focus

- Conflicting environment and command auth must not silently select another account or leak a key.
- Unknown/stale or independent quota pools must not route, forecast or limit the whole account.
- Existing non-portable flows must use Cursor labels and retain existing busy/batch constraints.
- Missing key/account and cancelled login must fail safely without global fallback.
- Installation must load both bundles and preserve existing host settings.

### Task 1: Environment and baseline
- [x] Inspect installed Cursor/Paseo usage and ACP interfaces without revealing secrets; run baseline suite.
- [x] Record conditional capabilities and test evidence in delivery documentation.

### Task 2: Cursor adapter and security
Files: server/cursor.ts, server/cursor.test.ts, server/binaries.ts.
- [x] RED: tests for per-account key persistence, isolation, cancellation, status parsing and conflicting env/command rejection.
- [x] GREEN: implement adapter plus launch checks using verified default endpoint and explicit empty conflicting auth variables.
- [x] Run adapter tests and commit.

### Task 3: Framework and UI
Files: shared/model.ts, server/families.ts, index.server.ts, server/service.ts, server/handoff.ts, client/add-account.tsx, existing service tests.
- [x] RED: Cursor routing, non-portable continuation and own-auth boundary tests.
- [x] GREEN: add family, register adapter, reuse routing/continuation, mask key input and correct provider labels.
- [x] Run typecheck, affected tests and commit.

### Task 4: Conditional usage
Files: server/cursor.ts, server/cursor.test.ts, shared/model.ts, server/usage-source.ts, server/service.ts, client/account-row.tsx.
- [x] RED: matched CLI token query, no global credential fallback for key accounts, amount-only response, stale/independent-pool exclusion.
- [x] GREEN: fixed official usage endpoint, separate plan balances, display-only quota until routing semantics verified, freshness guard.
- [x] Verify real read-only status/usage if available; report missing evidence without enabling speculative behavior; commit.

### Task 5: Verification and local installation
- [x] Full npm test, typecheck, mobile audit; review credential and routing boundaries and fix findings.
- [x] Install from this local checkout, reload only this plugin, inspect status/logs and RPC output without printing secrets.
- [x] Record actual evidence, untested real-account interactions and ordered commits; leave worktree intact.

## Execution ledger

- Setup: user explicitly authorized implementation and dev-ubuntu installation; execute inline without another plan approval round.
- Pre-flight: Tasks 2–4 share FamilyAdapter and UsageSchema; preserve other families' null/inherit semantics and add optional usage fields only.

- Baseline: 191 tests passed. Reviewed implementation now includes adapter, service and conditional-usage regressions.
- Review: managed API keys require AGENT_CLI_CREDENTIAL_STORE=memory; the installed CLI otherwise prefers stored OAuth tokens. Added persistent per-session key fingerprints to confirm rejection after reload without rejecting a replacement key.
- Ruling: browser multi-login, API-key usage, portable restore and early quota switching remain conditional — required account/protocol evidence is unavailable. They do not block basic installation per the spec.
- Live evidence: existing CLI status authenticated; fixed official usage endpoint HTTP 200; installed plugin RPC reports Cursor main ready with two usage windows.
- ACP evidence: initialize and one empty session/new passed; cross-process empty-session load rejected and a later session/new timed out. Full persisted-conversation restore and blocking extensions are not claimed verified.

- Final verification: 219 tests in 30 files passed; both typecheck targets and mobile audit exited 0. Plugin reloaded from this worktree; state RPC confirmed main Cursor ready with two usage windows and plugin logs contained no error-level entries.
