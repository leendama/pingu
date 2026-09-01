import { describe, expect, it } from "vitest";
import { agentInstructions, mayReplayResponseFailure } from "./agent.js";
import type { RuntimeSettings } from "./runtime-settings.js";

const settings: RuntimeSettings = {
  assistantName: "Test Assistant",
  ownerName: "the owner",
  timezone: "UTC",
  photonProjectId: "project",
  photonProjectSecret: "secret",
  openaiApiKey: "key",
  model: "gpt-5.6-luna",
};

describe("agent wiring", () => {
  it("can be imported without connecting and uses typed settings in its instructions", () => {
    const instructions = agentInstructions(settings, ["Plugin instruction"]);
    expect(instructions).toContain("You are Test Assistant, the owner's");
    expect(instructions).toContain("UTC");
    expect(instructions).toContain("Plugin instruction");
    expect(instructions).toContain("fewest words possible");
    expect(instructions).toContain("2 to 12 words");
    expect(instructions).toContain("do not guess or act");
    expect(instructions).toContain("Never hide or ignore a failed tool call");
  });

  it("replays recoverable failures only before an action starts", () => {
    expect(mayReplayResponseFailure({ status: 404, incomplete: false, sideEffectAttempted: false })).toBe(true);
    expect(mayReplayResponseFailure({ status: 404, incomplete: false, sideEffectAttempted: true })).toBe(false);
  });
});
