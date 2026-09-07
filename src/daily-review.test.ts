import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_REVIEW_CATCHUP_MS, dueDailyReview, startDailyReviewScheduler } from "./daily-review.js";

afterEach(() => { vi.useRealTimers(); });

describe("daily chief-of-staff scheduling", () => {
  it("runs from local 9am through the six-hour catch-up window only", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(dueDailyReview(at("2026-09-05T22:59:59Z"), "Australia/Melbourne")).toBeUndefined();
    expect(dueDailyReview(at("2026-09-05T23:00:00Z"), "Australia/Melbourne")?.date).toBe("2026-09-06");
    expect(dueDailyReview(at("2026-09-05T23:00:00Z") + DAILY_REVIEW_CATCHUP_MS, "Australia/Melbourne")).toBeDefined();
    expect(dueDailyReview(at("2026-09-05T23:00:01Z") + DAILY_REVIEW_CATCHUP_MS, "Australia/Melbourne")).toBeUndefined();
  });

  it("an immediate startup tick outside the window does not run a review", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const stop = startDailyReviewScheduler("Australia/Melbourne", run, { now: () => Date.parse("2026-09-06T20:00:00Z"), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).not.toHaveBeenCalled();
    stop();
  });
});
