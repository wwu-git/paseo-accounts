import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { SwitchGuard } from "./switch-guard";
import { mergeUsage, resetFromUsage, retryDelayMs, showLimit } from "./usage";

const reading = (patch: Partial<Usage> = {}): Usage => ({
  fetchedAt: "2026-09-23T08:00:00.000Z",
  windows: [
    { id: "five_hour", label: "5-hour", usedPercent: 92, resetsAt: "2026-09-23T08:10:00.000Z" },
    { id: "seven_day", label: "Weekly", usedPercent: 9, resetsAt: "2026-09-29T20:00:00.000Z" },
    { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 0, resetsAt: "2026-09-29T20:00:00.000Z" },
  ],
  error: null,
  cached: false,
  resets: null,
  ...patch,
});

describe("showLimit", () => {
  it("does not rewrite a display-only Console window after an unrelated model limit", () => {
    const consoleUsage=reading({routingEligible:false});
    expect(showLimit(consoleUsage,"2026-09-23T08:10:00.000Z")).toBe(consoleUsage);
  });
  it("fills the window that resets when the limit notice says", () => {
    const shown = showLimit(reading(), "2026-09-23T08:10:00.000Z");
    expect(shown.windows.map((window) => window.usedPercent)).toEqual([100, 9, 0]);
  });

  it("picks the fullest of windows resetting together", () => {
    const shown = showLimit(reading(), "2026-09-29T20:00:00.000Z");
    expect(shown.windows.map((window) => window.usedPercent)).toEqual([92, 100, 0]);
  });

  it("leaves the reading alone when no window matches or the time is unknown", () => {
    expect(showLimit(reading(), "2026-09-25T00:00:00.000Z")).toEqual(reading());
    expect(showLimit(reading(), null)).toEqual(reading());
  });
});

describe("resetFromUsage", () => {
  it("never derives model cooldowns from display-only Console allowance", () => {
    const full=reading({windows:[{id:"monthly",label:"Monthly",usedPercent:100,resetsAt:"2026-12-01T00:00:00Z"}]});
    expect(resetFromUsage(full)).toBe("2026-12-01T00:00:00Z");
    expect(resetFromUsage({...full,routingEligible:false})).toBeNull();
    expect(resetFromUsage({...full,cached:true})).toBeNull();
  });
});

describe("mergeUsage", () => {
  it("clears scoped windows when the source changes or can no longer be identified", () => {
    const previous=reading({sourceId:"console-one",routingEligible:false});
    for (const sourceId of ["console-two",undefined]) {
      const next=reading({sourceId,windows:[],routingEligible:false,error:"unavailable"});
      expect(mergeUsage(previous,next)).toBe(next);
    }
  });

  it("marks a retained same-source reading cached and preserves its attribution", () => {
    const previous=reading({sourceId:"console-one",sourceLabel:"Console One",routingEligible:false});
    const next=reading({sourceId:"console-one",windows:[],error:"offline"});
    expect(mergeUsage(previous,next)).toMatchObject({windows:previous.windows,cached:true,sourceLabel:"Console One",routingEligible:false});
  });

  it("keeps the last windows through a failed or rate-limited refresh", () => {
    const merged = mergeUsage(reading(), reading({ fetchedAt: "2026-09-23T08:05:00.000Z", windows: [], error: "offline" }));
    expect(merged.windows).toHaveLength(3);
    expect(merged.error).toBe("offline");
    expect(merged.fetchedAt).toBe("2026-09-23T08:00:00.000Z");
  });

  it("only lets the CLI's cached copy replace an older reading", () => {
    const older = reading({ fetchedAt: "2026-09-23T07:00:00.000Z", cached: true });
    expect(mergeUsage(reading(), older)).toEqual(reading());
    const newer = reading({ fetchedAt: "2026-09-23T08:30:00.000Z", cached: true });
    expect(mergeUsage(reading(), newer)).toBe(newer);
    expect(mergeUsage(undefined, older)).toBe(older);
  });
});

describe("retryDelayMs", () => {
  it("reads seconds and dates, within sane bounds", () => {
    const now = Date.parse("2026-09-23T08:00:00Z");
    expect(retryDelayMs("120", now)).toBe(120_000);
    expect(retryDelayMs("1", now)).toBe(30_000);
    expect(retryDelayMs("86400", now)).toBe(30 * 60_000);
    expect(retryDelayMs("Wed, 23 Sep 2026 08:05:00 GMT", now)).toBe(5 * 60_000);
    expect(retryDelayMs(null, now)).toBe(2 * 60_000);
    expect(retryDelayMs("soon", now)).toBe(2 * 60_000);
  });
});

describe("SwitchGuard", () => {
  it("counts only moves that happened, within the window", () => {
    const guard = new SwitchGuard(2, 10_000);
    expect(guard.allows("a", 0)).toBe(true);
    guard.note("a", 0);
    guard.note("a", 1_000);
    expect(guard.allows("a", 2_000)).toBe(false);
    expect(guard.allows("b", 2_000)).toBe(true);
    expect(guard.allows("a", 10_500)).toBe(true);
    guard.forget("a");
    expect(guard.allows("a", 2_000)).toBe(true);
  });
});
