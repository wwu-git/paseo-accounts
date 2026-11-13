# Cursor CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
- [ ] Inspect installed Cursor/Paseo usage and ACP interfaces without revealing secrets; run baseline suite.
- [ ] Record conditional capabilities and test evidence in delivery documentation.

### Task 2: Cursor adapter and security
Files: server/cursor.ts, server/cursor.test.ts, server/binaries.ts, server/paths.ts.
- [ ] RED: tests for per-account key persistence, isolation, cancellation, status parsing and conflicting env/command rejection.
- [ ] GREEN: implement adapter plus launch checks using verified default endpoint and explicit empty conflicting auth variables.
- [ ] Run adapter tests and commit.

### Task 3: Framework and UI
Files: shared/model.ts, server/families.ts, index.server.ts, server/service.ts, server/handoff.ts, client/add-account.tsx, existing service tests.
- [ ] RED: Cursor routing, non-portable continuation and own-auth boundary tests.
- [ ] GREEN: add family, register adapter, reuse routing/continuation, mask key input and correct provider labels.
- [ ] Run typecheck, affected tests and commit.

### Task 4: Conditional usage
Files: server/cursor.ts, server/cursor.test.ts, shared/model.ts, server/usage-source.ts, server/service.ts, client/account-row.tsx.
- [ ] RED: matched CLI token query, no global credential fallback for key accounts, amount-only response, stale/independent-pool exclusion.
- [ ] GREEN: fixed official usage endpoint, separate plan balances, display-only quota until routing semantics verified, freshness guard.
- [ ] Verify real read-only status/usage if available; report missing evidence without enabling speculative behavior; commit.

### Task 5: Verification and local installation
- [ ] Full npm test, typecheck, mobile audit; review credential and routing boundaries and fix findings.
- [ ] Install from this local checkout, reload only this plugin, inspect status/logs and RPC output without printing secrets.
- [ ] Record actual evidence, untested real-account interactions and ordered commits; leave worktree intact.

## Execution ledger

- Setup: user explicitly authorized implementation and dev-ubuntu installation; execute inline without another plan approval round.
- Pre-flight: Tasks 2–4 share FamilyAdapter and UsageSchema; preserve other families' null/inherit semantics and add optional usage fields only.
