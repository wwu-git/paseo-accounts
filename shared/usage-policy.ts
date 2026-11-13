import type { Usage } from "./model";

/** Preserve legacy providers; conditional readers carry their own expiry and routing permission. */
export function displayUsage(usage: Usage | undefined, now = Date.now()): Usage | undefined {
  if (!usage?.validUntil || (Number.isFinite(Date.parse(usage.validUntil)) && now < Date.parse(usage.validUntil))) return usage;
  return { ...usage, error: usage.error ?? "Usage is stale. Refresh to update it.", cached: true };
}

export function routingUsage(usage: Usage | undefined, now = Date.now()): Usage | undefined {
  if (!usage) return undefined;
  if (usage.routingEligible === false) return undefined;
  if (usage.validUntil !== undefined && (usage.error || usage.cached || !Number.isFinite(Date.parse(usage.validUntil)) || now >= Date.parse(usage.validUntil))) return undefined;
  return usage;
}
