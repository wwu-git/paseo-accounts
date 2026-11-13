# What is tested

Automated tests (`npm test`, run on every push) cover routing, failover, early switching, limit detection, usage parsing, banked resets, project folders, account naming at creation, Paseo's Usage view and forks. They use made-up accounts and provider replies, so they don't prove that a provider's real CLI or API still behaves the same.

## Checked on real accounts

On macOS 26 with Paseo 0.12, Claude Code 2.1 and several Claude Ultra accounts, used daily:

- Adding, signing out, signing in again and removing Claude accounts, from the desktop app and from a phone.
- Routing new agents, switching an open agent between accounts, failover on a real limit, and switching early before the limit.
- Usage and forecasts on the cards, the Ultra label, accounts without a 5-hour limit, and the signed-out badge.
- Project folders and disabling an account for a while.
- Kimi Code and OpenCode Go accounts side by side with Claude.
- The accounts listed in Paseo's Usage view (`paseo usage`), and `paseo run --env PASEO_ACCOUNT=…`.

## Only covered by automated tests

- ChatGPT (Codex) accounts, beyond sign-in and usage reading.
- GitHub Copilot, Pi and Oh My Pi accounts.
- Claude's paid extra usage: none of the test accounts has it turned on.
- Forks to another provider, and banked resets.
- Linux and Windows hosts, and daemons with a password.

If something here doesn't work for you, please [open an issue](https://github.com/wwu-git/paseo-accounts/issues) with your Paseo and CLI versions.


## Cursor CLI on dev-ubuntu

On Linux x86_64 with Paseo 0.15.4 and Cursor CLI 2026.10.16-e3cb207, verified the existing CLI login status, official usage query (HTTP 200), installed plugin state RPC and plugin running status. No real model prompt was sent. ACP initialization and one empty session creation succeeded; cross-process restoration of that empty session was rejected, and a later session creation timed out. This does not establish restoration of a persisted conversation.

Automated tests cover key persistence/cancellation, memory-store isolation settings, command and endpoint rejection, source labels on continuation, display-only pools, amount-only balances, stale reports, and authentication rejection across plugin reloads and key replacement. No second real Cursor account was supplied, so actual dual-account routing, model tools, full question/plan interactions, quota exhaustion and cross-account restore remain unverified. Browser multi-login, usage queries for API key accounts and quota-based early switching are disabled.
