# Cursor API key usage implementation plan

> Use superpowers:executing-plans with test-driven implementation in the existing isolated task worktree.

## Approved behavior

Read each managed Cursor account's current usage with its own user API key. Exchange the key at the fixed official `/auth/exchange_user_api_key` endpoint, then query `/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with the returned access token. Exchange responses and tokens remain in memory; no refresh token persistence, browser session borrowing, new dependencies or model generation. Both requests reject redirects and time out after 15 seconds. Existing main CLI-login usage remains supported.

Keep current display-only quota semantics, one-minute refresh spacing and five-minute freshness. A query failure must not mark credentials rejected. Scope cached data to the credential fingerprint; if the credential changes during a request, discard the result. Raw HTTP payloads and secrets must never appear in errors, logs or committed fixtures.

## Steps

- [x] Replace the old managed-usage rejection test with a failing isolated-key exchange/query test. Cover independent keys, malformed exchange data, HTTP/network failures, redirects, rejected keys and key replacement during a request.
- [x] Implement managed reading and scope both CLI and managed usage to credential fingerprints. Preserve stale Cursor data only when the source still matches; add regression coverage at the service boundary.
- [x] Update README; run focused tests, full suite, typecheck and a read-only review. Verify both real account readings through the installed plugin without publishing account details.
- [ ] Scan outgoing changes for credentials and private operational data, then integrate and push directly to the user's repository main branch without a PR.

## Review focus

- Managed usage must never read the global login or send its key to any configurable/redirected endpoint.
- A bad exchange response must never fall back to another account or reach the usage endpoint with an invalid token.
- Replacing a key must invalidate previous usage, including an in-flight response.
- Only the originating account's source may preserve stale values after failure.
- Existing CLI login and display-only model-limit handling must keep working.

## Validation

The isolated-key regression failed before implementation and passed afterward. The full suite passed 261 tests; typecheck and whitespace checks passed. One independent read-only review found no actionable issues. The local adapter and reloaded plugin both returned fresh, non-empty usage for the existing CLI login and a separate managed user key, with no query errors. No model requests were made for this validation. Account names, exact live percentages, source fingerprints, local paths and exchanged tokens are omitted from this public record.
