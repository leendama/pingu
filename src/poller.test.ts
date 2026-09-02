import { afterEach, describe, expect, it, vi } from "vitest";
import { startPoller } from "./poller.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("startPoller", () => {
  it("ticks immediately and then on every interval", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);
    const stop = startPoller("test poller", 1_000, tick);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });

  it("skips intervals while a tick is still in flight instead of overlapping", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const tick = vi.fn(() => gate.promise);
    const stop = startPoller("test poller", 1_000, tick);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tick).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops cleanly and never fires again", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);
    const stop = startPoller("test poller", 1_000, tick);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("logs a failed tick visibly without an unhandled rejection, and keeps polling", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failures = 0;
    const tick = vi.fn(async () => {
      failures += 1;
      if (failures === 1) throw new Error("store unavailable");
    });
    const stop = startPoller("test poller", 1_000, tick);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledWith("test poller tick failed:", "store unavailable");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not keep the process alive: the interval timer is unreffed", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const stop = startPoller("test poller", 1_000_000, async () => undefined);
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    stop();
  });
});
