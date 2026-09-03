import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "spectrum-ts";
import type { CalendarEventData, CalendarPort } from "./capabilities/calendar.js";
import { STALE_TRANSITION_MS, bookableRange, bookingMismatches, createSchedulingService, freeWindows, requestStore, zonedTimestamp } from "./scheduling.js";
import { defaultSchedulingSettings } from "./scheduling-settings.js";

let directory: string;
// Tuesday 1 September 2026, 08:00 UTC.
const NOW = Date.parse("2026-09-01T08:00:00Z");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-scheduling-test-"));
  process.env.PHOTON_DATA_DIR = directory;
});

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

interface FakeCalendar extends CalendarPort {
  events: Map<string, CalendarEventData>;
  inserts: Array<{ body: Record<string, unknown>; sendUpdates: string; options?: { conferenceDataVersion?: 0 | 1 } }>;
  deletes: string[];
}

function fakeCalendar(initial: CalendarEventData[] = []): FakeCalendar {
  const events = new Map(initial.map((event) => [event.id!, structuredClone(event)]));
  const inserts: FakeCalendar["inserts"] = [];
  const deletes: string[] = [];
  return {
    events, inserts, deletes,
    async getTimezone() { return "UTC"; },
    async listEvents() { return [...events.values()]; },
    async getEvent(id) { return events.get(id); },
    async insertEvent(body, sendUpdates, options) {
      inserts.push({ body, sendUpdates, options });
      const event: CalendarEventData = { id: `evt-${inserts.length}`, ...body, hangoutLink: options?.conferenceDataVersion ? "https://meet.google.com/abc-defg-hij" : undefined } as CalendarEventData;
      if (body.start && typeof body.start === "object") event.start = { dateTime: new Date(String((body.start as { dateTime: string }).dateTime)).toISOString() };
      if (body.end && typeof body.end === "object") event.end = { dateTime: new Date(String((body.end as { dateTime: string }).dateTime)).toISOString() };
      events.set(event.id!, event);
      return event;
    },
    async patchEvent(id, body) { const event = { ...events.get(id), ...body }; events.set(id, event); return event; },
    async deleteEvent(id) { deletes.push(id); events.delete(id); },
  };
}

function service(calendar: CalendarPort, overrides: Partial<Parameters<typeof createSchedulingService>[0]> = {}) {
  const send = vi.fn(async (_spaceId: string, _text: string) => undefined);
  const instance = createSchedulingService({
    settings: { timezone: "UTC", ownerName: "Alex", assistantName: "Pingu", scheduling: defaultSchedulingSettings },
    calendar,
    send,
    ownerSpaces: async () => ["owner-dm"],
    now: () => NOW,
    ...overrides,
  });
  return { service: instance, send };
}

const guest = { guestSenderId: "+15550102000", guestSpaceId: "guest-dm", guestName: "Sam", purpose: "catch up on the tender", email: "sam@example.com", durationMinutes: 30, guestTimezone: "Europe/London" };

describe("free windows", () => {
  it("pads busy blocks with the buffer and returns at most the configured number of windows", () => {
    const hour = 60 * 60_000;
    const windows = freeWindows({
      range: { startMs: 9 * hour, endMs: 17 * hour },
      busy: [{ startMs: 10 * hour, endMs: 11 * hour }, { startMs: 14 * hour, endMs: 14.5 * hour }],
      durationMs: 30 * 60_000,
      bufferMs: 15 * 60_000,
      earliestMs: 0,
      maxWindows: 2,
    });
    expect(windows).toEqual([
      { startMs: 9 * hour, endMs: 9.75 * hour },
      { startMs: 11.25 * hour, endMs: 13.75 * hour },
    ]);
  });

  it("drops gaps shorter than the meeting and honours minimum notice", () => {
    const hour = 60 * 60_000;
    const windows = freeWindows({
      range: { startMs: 9 * hour, endMs: 12 * hour },
      busy: [{ startMs: 9.5 * hour, endMs: 10 * hour }],
      durationMs: 60 * 60_000,
      bufferMs: 0,
      earliestMs: 10.5 * hour,
      maxWindows: 5,
    });
    expect(windows).toEqual([{ startMs: 10.5 * hour, endMs: 12 * hour }]);
  });

  it("closes weekends by default and resolves bookable hours in the owner's timezone", () => {
    expect(bookableRange("2026-09-05", defaultSchedulingSettings, "UTC")).toBeUndefined();
    const monday = bookableRange("2026-09-07", defaultSchedulingSettings, "Australia/Sydney")!;
    expect(new Date(monday.startMs).toISOString()).toBe("2026-09-06T23:00:00.000Z");
    expect(new Date(monday.endMs).toISOString()).toBe("2026-09-07T07:00:00.000Z");
    expect(new Date(zonedTimestamp("2026-09-07", 9 * 60, "Europe/London")).toISOString()).toBe("2026-09-07T08:00:00.000Z");
  });
});

describe("availability", () => {
  it("shows free windows in the guest's timezone without any event detail", async () => {
    const calendar = fakeCalendar([
      { id: "busy", summary: "Secret board meeting", start: { dateTime: "2026-09-02T10:00:00Z" }, end: { dateTime: "2026-09-02T11:00:00Z" } },
      { id: "free", summary: "Focus", transparency: "transparent", start: { dateTime: "2026-09-02T13:00:00Z" }, end: { dateTime: "2026-09-02T14:00:00Z" } },
    ]);
    const { service: scheduling } = service(calendar);
    const result = await scheduling.availability({ date: "2026-09-02", durationMinutes: 30, guestTimezone: "Europe/London" });
    expect(result.windows.map((window) => window.label)).toEqual(["10:00 am to 10:45 am Europe/London", "12:15 pm to 6:00 pm Europe/London"]);
    expect(JSON.stringify(result)).not.toContain("board");
    expect(result.note).toContain("not confirmed");
  });

  it("refuses dates past the lookahead and unknown durations", async () => {
    const { service: scheduling } = service(fakeCalendar());
    expect((await scheduling.availability({ date: "2026-10-30", durationMinutes: 30, guestTimezone: "UTC" })).note).toContain("14 days");
    await expect(scheduling.availability({ date: "2026-09-02", durationMinutes: 25, guestTimezone: "UTC" })).rejects.toThrow(/one of 15, 30, 45, 60/);
    await expect(scheduling.availability({ date: "2026-09-02", durationMinutes: 30, guestTimezone: "Mars/Olympus" })).rejects.toThrow(/Unknown timezone/);
  });
});

describe("request lifecycle", () => {
  it("stores a pending request, texts the owner, and books only after a yes replied to that message", async () => {
    const calendar = fakeCalendar();
    const { service: scheduling, send } = service(calendar);
    const submitted = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    expect(submitted.request).toMatchObject({ status: "pending", guestName: "Sam", email: "sam@example.com" });
    expect(submitted.guestText).toContain("isn't held");
    const ownerText = send.mock.calls[0]?.[1] ?? "";
    expect(send.mock.calls[0]?.[0]).toBe("owner-dm");
    expect(ownerText).toContain(submitted.request.code);
    expect(ownerText).toContain("unverified");
    expect(ownerText).toContain("2:00 pm Europe/London");

    const reply = { direction: "inbound", content: { type: "reply", content: { type: "text", text: "yes" }, target: { id: "t", direction: "outbound", content: { type: "text", text: ownerText } } } } as unknown as Message;
    const outcome = await scheduling.resolveOwnerReply({ message: reply, texts: ["yes"], spaceId: "owner-dm", senderId: "owner" });
    expect(outcome).toBe("Booked and invitation sent to sam@example.com. Meet link is on the event.");
    expect(calendar.inserts[0]).toMatchObject({ sendUpdates: "all", options: { conferenceDataVersion: 1 } });
    expect(calendar.inserts[0]?.body).toMatchObject({ summary: "Call with Sam", attendees: [{ email: "sam@example.com" }] });
    expect(String(calendar.inserts[0]?.body.description)).toContain("unverified");
    const stored = (await requestStore.read()).requests[0]!;
    expect(stored).toMatchObject({ status: "booked", eventId: "evt-1", meetLink: "https://meet.google.com/abc-defg-hij" });
    expect(send.mock.calls[1]?.[0]).toBe("guest-dm");
    expect(send.mock.calls[1]?.[1]).toContain("Confirmed");
  });

  it("asks which request a bare yes means instead of guessing", async () => {
    const { service: scheduling } = service(fakeCalendar());
    await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    const bare = { direction: "inbound", content: { type: "text", text: "yes" } } as unknown as Message;
    expect(await scheduling.resolveOwnerReply({ message: bare, texts: ["yes"], spaceId: "owner-dm", senderId: "owner" })).toContain("Which request?");
    const unrelated = { direction: "inbound", content: { type: "text", text: "what's on today" } } as unknown as Message;
    expect(await scheduling.resolveOwnerReply({ message: unrelated, texts: ["what's on today"], spaceId: "owner-dm", senderId: "owner" })).toBeUndefined();
  });

  it("creates nothing when the slot was taken before approval, and tells both people", async () => {
    const calendar = fakeCalendar();
    const { service: scheduling, send } = service(calendar);
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    calendar.events.set("taken", { id: "taken", summary: "Taken", start: { dateTime: "2026-09-02T13:00:00Z" }, end: { dateTime: "2026-09-02T13:30:00Z" } });
    const outcome = await scheduling.approve(request.code);
    expect(outcome).toContain("The slot became unavailable, so I did not create anything.");
    expect(calendar.inserts).toHaveLength(0);
    expect((await requestStore.read()).requests[0]?.status).toBe("failed");
    expect(send.mock.calls.at(-1)?.[1]).toContain("did not create anything");
  });

  it("reports a Google rejection as nothing changed", async () => {
    const calendar = fakeCalendar();
    calendar.insertEvent = async () => { throw new Error("quota"); };
    const { service: scheduling } = service(calendar);
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    expect(await scheduling.approve(request.code)).toContain("Google rejected the request. Nothing was changed.");
  });

  it("declines, expires, and refuses a late approval", async () => {
    const calendar = fakeCalendar();
    let now = NOW;
    const { service: scheduling, send } = service(calendar, { now: () => now });
    const first = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    expect(await scheduling.decline(first.request.code)).toContain("Declined");
    expect(send.mock.calls.at(-1)?.[1]).toContain("can't make that time");

    const second = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T14:00:00Z" });
    now = NOW + 25 * 60 * 60_000;
    await scheduling.expirePending();
    expect((await requestStore.read()).requests.find((request) => request.code === second.request.code)?.status).toBe("expired");
    expect(send.mock.calls.at(-1)?.[1]).toContain("expired");
    expect(await scheduling.approve(second.request.code)).toContain("already expired");
  });

  it("allows one pending request per guest and rejects times outside the free windows", async () => {
    const { service: scheduling } = service(fakeCalendar());
    await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    await expect(scheduling.submitRequest({ ...guest, startIso: "2026-09-02T15:00:00Z" })).rejects.toThrow(/already have a request/);
    await expect(scheduling.submitRequest({ ...guest, guestSenderId: "other", startIso: "2026-09-02T20:00:00Z" })).rejects.toThrow(/not bookable/);
    await expect(scheduling.submitRequest({ ...guest, guestSenderId: "other", email: "nope", startIso: "2026-09-02T13:00:00Z" })).rejects.toThrow(/valid email/);
  });

  it("lets the guest cancel their booking, verifies the event is gone, and tells the owner", async () => {
    const calendar = fakeCalendar();
    const { service: scheduling, send } = service(calendar);
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    await scheduling.approve(request.code);
    const outcome = await scheduling.cancelGuestBooking(guest.guestSenderId);
    expect(outcome).toContain("Cancelled. The invitation has been withdrawn.");
    expect(calendar.deletes).toEqual(["evt-1"]);
    expect((await requestStore.read()).requests[0]?.status).toBe("cancelled");
    expect(send.mock.calls.at(-1)?.[0]).toBe("owner-dm");
    expect(send.mock.calls.at(-1)?.[1]).toContain("cancelled");
    expect(await scheduling.cancelGuestBooking(guest.guestSenderId)).toContain("no booking");
  });

  it("sanitises guest text before it reaches the calendar", async () => {
    const calendar = fakeCalendar();
    const { service: scheduling } = service(calendar);
    const { request } = await scheduling.submitRequest({ ...guest, guestName: "Sam <b>", purpose: "line one\nline two\t".repeat(30), startIso: "2026-09-02T13:00:00Z" });
    expect(request.guestName).toBe("Sam <b>");
    expect(request.purpose.length).toBeLessThanOrEqual(200);
    expect(request.purpose).not.toContain("\n");
  });

  it("never tells the guest a request was sent when no owner chat received it", async () => {
    const calendar = fakeCalendar();
    const { service: scheduling } = service(calendar, { ownerSpaces: async () => [] });
    const result = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    expect(result.delivered).toBe(false);
    expect(result.guestText).toContain("nothing was sent");
    expect(result.guestText).not.toContain("Sent to");
    expect((await requestStore.read()).requests[0]).toMatchObject({ status: "failed" });

    const failingSend = vi.fn(async () => { throw new Error("space unavailable"); });
    const { service: broken } = service(calendar, { send: failingSend });
    const second = await broken.submitRequest({ ...guest, startIso: "2026-09-02T14:00:00Z" });
    expect(second.delivered).toBe(false);
  });

  it("lets only one caller book a request when two approvals race", async () => {
    const calendar = fakeCalendar();
    let releaseInsert!: () => void;
    const gate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const insert = calendar.insertEvent.bind(calendar);
    calendar.insertEvent = async (body, sendUpdates, options) => { await gate; return insert(body, sendUpdates, options); };
    const { service: scheduling } = service(calendar);
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    const first = scheduling.approve(request.code);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await scheduling.approve(request.code);
    expect(second).toContain("being booked right now");
    releaseInsert();
    expect(await first).toContain("Booked");
    expect(calendar.inserts).toHaveLength(1);
  });

  it("refuses a cancellation while a booking is mid-flight and recovers a stale transition", async () => {
    const calendar = fakeCalendar();
    let now = NOW;
    const { service: scheduling, send } = service(calendar, { now: () => now });
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    await requestStore.update((state) => {
      state.requests[0]!.status = "approving";
      state.requests[0]!.transitionAt = new Date(now).toISOString();
      return { result: undefined, changed: true };
    });
    expect(await scheduling.cancelGuestBooking(guest.guestSenderId)).toContain("no booking");
    expect(await scheduling.approve(request.code)).toContain("being booked right now");

    now = NOW + STALE_TRANSITION_MS + 1;
    await scheduling.recoverStale();
    expect((await requestStore.read()).requests[0]).toMatchObject({ status: "failed" });
    expect(send.mock.calls.at(-2)?.[1]).toContain("interrupted");
  });

  it("settles a stale cancellation from what the calendar actually holds", async () => {
    const calendar = fakeCalendar();
    let now = NOW;
    const { service: scheduling } = service(calendar, { now: () => now });
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    await scheduling.approve(request.code);
    await requestStore.update((state) => {
      state.requests[0]!.status = "cancelling";
      state.requests[0]!.transitionAt = new Date(now).toISOString();
      return { result: undefined, changed: true };
    });
    now = NOW + STALE_TRANSITION_MS + 1;
    await scheduling.recoverStale();
    expect((await requestStore.read()).requests[0]?.status).toBe("booked");
    calendar.events.delete("evt-1");
    await requestStore.update((state) => { state.requests[0]!.status = "cancelling"; return { result: undefined, changed: true }; });
    await scheduling.recoverStale();
    expect((await requestStore.read()).requests[0]?.status).toBe("cancelled");
  });

  it("verifies the read-back event against the request and reports a missing Meet link visibly", async () => {
    const request = { startIso: "2026-09-02T13:00:00.000Z", endIso: "2026-09-02T13:30:00.000Z", email: "sam@example.com" };
    expect(bookingMismatches({ id: "e", start: { dateTime: "2026-09-02T14:00:00+01:00" }, end: { dateTime: "2026-09-02T14:30:00+01:00" }, attendees: [{ email: "SAM@example.com" }] }, request)).toEqual([]);
    expect(bookingMismatches({ id: "e", start: { dateTime: "2026-09-02T15:00:00Z" }, end: { dateTime: "2026-09-02T13:30:00Z" }, attendees: [] }, request)).toEqual(["start time", "guest attendee"]);

    const calendar = fakeCalendar();
    const insert = calendar.insertEvent.bind(calendar);
    calendar.insertEvent = async (body, sendUpdates) => insert(body, sendUpdates, { conferenceDataVersion: 0 });
    const { service: scheduling } = service(calendar);
    const { request: submitted } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    const outcome = await scheduling.approve(submitted.code);
    expect(outcome).toContain("Booked and invitation sent");
    expect(outcome).toContain("did not attach a Meet link");
    const stored = (await requestStore.read()).requests[0]!;
    expect(stored.status).toBe("booked");
    expect(stored.meetLink).toBeUndefined();
  });

  it("does not report a booking whose event came back at the wrong time", async () => {
    const calendar = fakeCalendar();
    const insert = calendar.insertEvent.bind(calendar);
    calendar.insertEvent = async (body, sendUpdates, options) => {
      const event = await insert(body, sendUpdates, options);
      calendar.events.set(event.id!, { ...event, start: { dateTime: "2026-09-02T16:00:00Z" } });
      return event;
    };
    const { service: scheduling, send } = service(calendar);
    const { request } = await scheduling.submitRequest({ ...guest, startIso: "2026-09-02T13:00:00Z" });
    const outcome = await scheduling.approve(request.code);
    expect(outcome).toContain("does not match the request (start time)");
    expect((await requestStore.read()).requests[0]).toMatchObject({ status: "failed", eventId: "evt-1" });
    expect(send.mock.calls.at(-1)?.[1]).toContain("Something went wrong");
  });
});
