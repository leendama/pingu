import { describe, expect, it } from "vitest";
import { CHIEF_DECISION_FRAMEWORK, OWNER_DECISION_FRAMEWORK, ownerDecisionFramework } from "./owner-decision-framework.js";

describe("owner decision framework", () => {
  it("is available only in the owner's direct conversation", () => {
    expect(ownerDecisionFramework({ role: "owner", isGroup: false })).toBe(OWNER_DECISION_FRAMEWORK);
    expect(ownerDecisionFramework({ role: "owner", isGroup: true })).toBe("");
    expect(ownerDecisionFramework({ role: "guest", isGroup: false })).toBe("");
  });

  it("protects explicit commitments and relationships while requiring a concrete trade-off", () => {
    expect(OWNER_DECISION_FRAMEWORK).toContain("Treat an explicit calendar commitment as fixed");
    expect(OWNER_DECISION_FRAMEWORK).toContain("relationships or health");
    expect(OWNER_DECISION_FRAMEWORK).toContain("State the main trade-off");
    expect(CHIEF_DECISION_FRAMEWORK).toContain("routine message is not automatically important");
  });
});
