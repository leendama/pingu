import { afterEach, describe, expect, it, vi } from "vitest";
import { liveTime, temporalInstructions } from "./time-context.js";
import { clockPlugin } from "./capabilities/clock.js";
import { markHistoricalClocks, presentHistoricalCalendars } from "./reply-generator.js";
import type { ToolRunContext } from "./plugins.js";
import type { ResponseInputItem } from "openai/resources/responses/responses";

afterEach(() => vi.useRealTimers());

describe("temporal context regressions", () => {
  it("normalizes saved calendar results without rewriting the transcript", () => {
    const output = JSON.stringify({ events: [{ start: { dateTime: "2029-01-17T17:00:00+09:00", timeZone: "UTC" } }] });
    const history: ResponseInputItem[] = [
      { type: "function_call", call_id: "calendar", name: "search_calendar", arguments: "{}" },
      { type: "function_call_output", call_id: "calendar", output },
    ];
    const projected = presentHistoricalCalendars(history, "Asia/Tokyo");
    expect(projected[1]).toMatchObject({ output: expect.stringContaining('"timeZone":"Asia/Tokyo"') });
    expect(history[1]).toMatchObject({ output });
  });
  it("uses the user's calendar date even when UTC is on the previous day", () => {
    expect(liveTime("Asia/Tokyo", new Date("2029-03-03T23:30:00Z"))).toMatchObject({ local_date: "2029-03-04", timezone: "Asia/Tokyo" });
    expect(liveTime("America/Los_Angeles", new Date("2029-03-04T01:00:00Z"))).toMatchObject({ local_date: "2029-03-03" });
  });

  it("refreshes on every call, including midnight and daylight saving transitions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-03-03T14:59:00Z"));
    expect(temporalInstructions("Asia/Tokyo")).toContain('"local_date":"2029-03-03"');
    vi.advanceTimersByTime(120_000);
    expect(temporalInstructions("Asia/Tokyo")).toContain('"local_date":"2029-03-04"');
    expect(liveTime("America/New_York", new Date("2029-03-11T07:01:00Z")).local_time).toContain("3:01:00");
  });

  it("defaults the clock tool to the configured timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2029-03-03T23:30:00Z"));
    const result = await clockPlugin().run("get_current_time", '{"timezone":null}', { config: { timezone: "Asia/Tokyo" } } as ToolRunContext);
    expect(JSON.parse(result.output)).toMatchObject({ local_date: "2029-03-04", timezone: "Asia/Tokyo" });
  });

  it("marks old clock results without changing stored history or other tool results", () => {
    const history: ResponseInputItem[] = [
      { type: "function_call", call_id: "clock", name: "get_current_time", arguments: "{}" },
      { type: "function_call_output", call_id: "clock", output: '{"local_date":"2029-03-03"}' },
      { type: "function_call_output", call_id: "calendar", output: "event data" },
    ];
    const projected = markHistoricalClocks(history);
    expect(projected[1]).toMatchObject({ call_id: "clock", output: expect.stringContaining("earlier turn") });
    expect(history[1]).toMatchObject({ output: '{"local_date":"2029-03-03"}' });
    expect(projected[2]).toBe(history[2]);
  });
});
