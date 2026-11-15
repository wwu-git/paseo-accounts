import { describe, expect, it } from "vitest";
import { AccountViewSchema, StateViewSchema, type Family } from "../shared/model";
import { shownFamilies } from "./store";

function account(family: Family, kind = "main", status = "ready") {
  return AccountViewSchema.parse({
    id: `${family}-${kind}`, family, kind, status, label: family,
    email: null, plan: null, organization: null, isDefault: true,
    limitedUntil: null, usage: null, agentCount: 0, home: null,
  });
}

function state(accounts: ReturnType<typeof account>[]) {
  return StateViewSchema.parse({
    accounts, agents: [], logins: [], providers: {}, canReopen: true,
    showComposerPill: true, warnings: [],
  });
}

describe("visible account families", () => {
  it("shows an authenticated CLI login alongside other managed accounts without active agents", () => {
    expect(shownFamilies(state([
      account("codex", "managed"), account("cursor", "managed"), account("opencode"),
    ]))).toContain("opencode");
  });

  it("keeps unused signed-out CLI logins hidden", () => {
    expect(shownFamilies(state([
      account("codex", "managed"), account("opencode", "main", "signed_out"),
    ]))).toEqual(["codex"]);
  });

  it("shows no families before state loads", () => {
    expect(shownFamilies(null)).toEqual([]);
  });
});
