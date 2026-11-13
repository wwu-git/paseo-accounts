import { describe, expect, it } from "vitest";
import { displayUsage, routingUsage } from "./usage-policy";
import { UsageSchema } from "./model";

const now = Date.parse("2026-11-13T11:00:00Z");
const usage = () => UsageSchema.parse({ fetchedAt: new Date(now).toISOString(), validUntil: new Date(now + 60000).toISOString(), routingEligible: false, error: null, windows: [{ id: "total", label: "Total", usedPercent: 100, resetsAt: null }] });
describe("conditional Cursor usage", () => {
 it("does not route on independent display-only pools even when fresh", () => { expect(routingUsage(usage(), now)).toBeUndefined(); });
 it("marks expired displays stale and excludes expired readings from routing", () => {
   expect(displayUsage(usage(), now + 60001)?.error).toMatch(/stale/i);
   expect(routingUsage({ ...usage(), routingEligible: true }, now + 60001)).toBeUndefined();
 });
 it("excludes failed and cached readings for conditional providers", () => {
   expect(routingUsage({ ...usage(), routingEligible: true, error: "failed" }, now)).toBeUndefined();
   expect(routingUsage({ ...usage(), routingEligible: true, cached: true }, now)).toBeUndefined();
 });
 it("preserves legacy provider caching behavior", () => {
   const old = UsageSchema.parse({ fetchedAt: "2020-01-01", windows: [], error: "old cached data", cached: true });
   expect(routingUsage(old, now)).toBe(old);
 });
});
