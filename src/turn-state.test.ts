import { describe, expect, it } from "vitest";
import { resetAttemptOutputs } from "./turn-state.js";

describe("turn attempt state", () => {
  it("clears delivery outputs before replaying a request", () => {
    const state = { richResponseSent: true, draftForReview: "draft-1" };
    resetAttemptOutputs(state);
    expect(state).toEqual({ richResponseSent: false, draftForReview: undefined });
  });
});
