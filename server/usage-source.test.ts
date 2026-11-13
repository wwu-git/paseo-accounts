import { describe, expect, it } from "vitest";
import { StoredAccountSchema } from "./state";
import { usageKey, usageReport } from "./usage-source";

const account = (patch: Record<string, unknown> = {}) =>
  StoredAccountSchema.parse({ id: "claude-abc", family: "claude", label: "Work", kind: "managed", home: "/h", plan: "ultra", createdAt: "2026-11-01T00:00:00Z", ...patch });

describe("Paseo usage source", () => {
  it("reports the last reading with the account-wide windows in the summary", () => {
    const report = usageReport(account(), {
      fetchedAt: "2026-11-01T00:00:00Z",
      error: null,
      cached: false,
      resets: null,
      windows: [
        { id: "seven_day", label: "Weekly", usedPercent: 85, resetsAt: "2026-11-05T00:00:00Z" },
        { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 1, resetsAt: null },
      ],
    });
    expect(report).toMatchObject({ status: "available", planLabel: "Ultra" });
    if (report.status !== "available") throw new Error("expected a reading");
    expect(report.windows[0]).toMatchObject({ shortLabel: "wk", summary: true, usedPct: 85, remainingPct: 15, tone: "warning" });
    expect(report.windows[1]?.summary).toBeUndefined();
  });

  it("says a signed-out account needs signing in, not that it has no usage", () => {
    expect(usageReport(account({ signedIn: false }), undefined)).toEqual({ status: "error", error: "Signed out. Sign in again in Accounts." });
  });

  it("keeps keys inside Paseo's character set", () => {
    expect(usageKey("kimi:a b/c")).toBe("kimi-a-b-c");
  });
});

it("reports plan balances without pretending they are extra usage or percentages", () => {
  const report = usageReport(account({ family: "cursor", plan: null }), {
    fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null,
    balances: [{ id: "plan_usage", label: "Plan usage", usedMinor: 200, limitMinor: 2000, remainingMinor: 1800, currency: "USD", exponent: 2 }],
  });
  expect(report).toMatchObject({ status: "available", windows: [], balances: [{ id: "plan_usage", used: 2, remaining: 18, limit: 20, unit: "usd" }] });
});
