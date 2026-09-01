import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "../plugins.js";
import { calendarPlugin, type CalendarEventData, type CalendarPort } from "./calendar.js";

interface RecordedCall {
  method: "list" | "get" | "insert" | "patch" | "delete";
  eventId?: string;
  requestBody?: Record<string, unknown>;
  sendUpdates?: "all" | "none";
}

function fakePort(calls: RecordedCall[], initial: CalendarEventData[] = []): CalendarPort {
  const events = new Map(initial.map((event) => [event.id!, structuredClone(event)]));
  return {
    async listEvents() {
      calls.push({ method: "list" });
      return [...events.values()];
    },
    async getEvent(eventId) {
      calls.push({ method: "get", eventId });
      return events.get(eventId);
    },
    async insertEvent(requestBody, sendUpdates) {
      calls.push({ method: "insert", requestBody, sendUpdates });
      return { id: "evt-new", summary: String(requestBody.summary) };
    },
    async patchEvent(eventId, requestBody, sendUpdates) {
      calls.push({ method: "patch", eventId, requestBody, sendUpdates });
      const event = { ...(events.get(eventId) ?? { id: eventId }), ...requestBody };
      events.set(eventId, event);
      return event;
    },
    async deleteEvent(eventId, sendUpdates) {
      calls.push({ method: "delete", eventId, sendUpdates });
      events.delete(eventId);
    },
  };
}

const context = { isGroup: false, config: { timezone: "UTC" } } as ToolRunContext;

describe("calendarPlugin", () => {
  it("creates a timed event with the configured timezone and notifies attendees only when present", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls));

    const noAttendees = await plugin.run("create_calendar_event", JSON.stringify({
      title: "Standup", start: "2026-09-01T09:00:00", end: "2026-09-01T09:15:00",
      timezone: "UTC", description: null, location: null, attendees: [],
    }), context);
    expect(JSON.parse(noAttendees.output).created).toBe(true);
    const inserts = () => calls.filter((call) => call.method === "insert");
    expect(inserts()[0]).toMatchObject({
      method: "insert",
      sendUpdates: "none",
      requestBody: { start: { dateTime: "2026-09-01T09:00:00", timeZone: "UTC" } },
    });

    await plugin.run("create_calendar_event", JSON.stringify({
      title: "Review", start: "2026-09-01T10:00:00", end: "2026-09-01T11:00:00",
      timezone: "UTC", description: null, location: null, attendees: ["a@example.com"],
    }), context);
    expect(inserts()[1]).toMatchObject({ method: "insert", sendUpdates: "all" });
  });

  it("creates an all-day event from bare dates", async () => {
    const calls: RecordedCall[] = [];
    await calendarPlugin(fakePort(calls)).run("create_calendar_event", JSON.stringify({
      title: "Conference", start: "2026-09-01", end: "2026-09-03",
      timezone: "UTC", description: null, location: null, attendees: [],
    }), context);
    expect(calls[0]?.requestBody).toMatchObject({
      start: { date: "2026-09-01" },
      end: { date: "2026-09-03" },
    });
  });

  it("rejects a mixed all-day and timed window", async () => {
    const plugin = calendarPlugin(fakePort([]));
    const result = await plugin.run("create_calendar_event", JSON.stringify({
      title: "Broken", start: "2026-09-01", end: "2026-09-01T17:00:00",
      timezone: "UTC", description: null, location: null, attendees: [],
    }), context);
    expect(JSON.parse(result.output).error).toMatch(/both be all-day dates or both be date-times/);
  });

  it("edit supports clearing and preserving description and location independently", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls));
    await plugin.run("edit_calendar_event", JSON.stringify({
      event_id: "evt-9", title: null, new_start: null, new_end: null,
      timezone: "UTC", description: null, clear_description: true,
      location: "Room 4", clear_location: false, attendees: null,
    }), context);
    expect(calls[0]).toMatchObject({
      method: "patch",
      eventId: "evt-9",
      sendUpdates: "all",
      requestBody: { description: "", location: "Room 4" },
    });
  });

  it("edit rejects an empty change set and a one-sided time change", async () => {
    const plugin = calendarPlugin(fakePort([]));
    const empty = await plugin.run("edit_calendar_event", JSON.stringify({
      event_id: "evt-9", title: null, new_start: null, new_end: null,
      timezone: "UTC", description: null, clear_description: false,
      location: null, clear_location: false, attendees: null,
    }), context);
    expect(JSON.parse(empty.output).error).toMatch(/No event changes/);

    const oneSided = await plugin.run("edit_calendar_event", JSON.stringify({
      event_id: "evt-9", title: null, new_start: "2026-09-01T10:00:00", new_end: null,
      timezone: "UTC", description: null, clear_description: false,
      location: null, clear_location: false, attendees: null,
    }), context);
    expect(JSON.parse(oneSided.output).error).toMatch(/both new_start and new_end/);
  });

  it("deletes an exact event and notifies attendees", async () => {
    const calls: RecordedCall[] = [];
    const result = await calendarPlugin(fakePort(calls)).run(
      "delete_calendar_event",
      JSON.stringify({ event_id: "evt-9" }),
      context,
    );
    expect(JSON.parse(result.output)).toEqual({ deleted: true, event_id: "evt-9" });
    expect(calls).toEqual([{ method: "delete", eventId: "evt-9", sendUpdates: "all" }]);
  });

  it("changes and verifies an event colour from a plain colour name", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [{ id: "evt-color", summary: "Focus" }]));
    const result = await plugin.run(
      "set_calendar_event_color",
      JSON.stringify({ event_id: "evt-color", color: "red" }),
      context,
    );
    expect(JSON.parse(result.output)).toEqual({ recolored: true, event_id: "evt-color", color_id: "11" });
    expect(calls).toContainEqual({
      method: "patch",
      eventId: "evt-color",
      requestBody: { colorId: "11" },
      sendUpdates: "none",
    });
  });

  it("copies an exact Google event colour ID and rejects unsupported colours", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [{ id: "evt-color", summary: "Focus" }]));
    const copied = await plugin.run(
      "set_calendar_event_color",
      JSON.stringify({ event_id: "evt-color", color: "7" }),
      context,
    );
    expect(JSON.parse(copied.output).color_id).toBe("7");

    const invalid = await plugin.run(
      "set_calendar_event_color",
      JSON.stringify({ event_id: "evt-color", color: "ultraviolet" }),
      context,
    );
    expect(JSON.parse(invalid.output).error).toMatch(/Unsupported event colour/);
  });

  it("rejects a single move that overlaps an existing event", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "move", summary: "Focus", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
      { id: "busy", summary: "Meeting", start: { dateTime: "2026-09-01T18:30:00Z" }, end: { dateTime: "2026-09-01T19:30:00Z" } },
    ]));
    const result = await plugin.run("reschedule_calendar_event", JSON.stringify({
      event_id: "move", new_start: "2026-09-01T18:00:00Z", new_end: "2026-09-01T19:00:00Z", timezone: "UTC",
    }), context);
    expect(JSON.parse(result.output).error).toMatch(/conflicts with existing event busy/);
    expect(calls.some((call) => call.method === "patch")).toBe(false);
  });

  it("moves a complete ordered sequence and deletes a duplicate after verification", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "a", summary: "Course lessons 1-2", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
      { id: "b", summary: "Course lessons 3-4", start: { dateTime: "2026-09-02T09:00:00Z" }, end: { dateTime: "2026-09-02T10:00:00Z" } },
      { id: "copy", summary: "Course lessons 1-2", start: { dateTime: "2026-09-03T09:00:00Z" }, end: { dateTime: "2026-09-03T10:00:00Z" } },
    ]));
    const result = await plugin.run("bulk_reschedule_calendar_events", JSON.stringify({
      moves: [
        { event_id: "a", new_start: "2026-09-04T09:00:00Z", new_end: "2026-09-04T10:00:00Z", sequence_group: "Course lessons" },
        { event_id: "b", new_start: "2026-09-05T09:00:00Z", new_end: "2026-09-05T10:00:00Z", sequence_group: "Course lessons" },
      ],
      duplicate_event_ids: ["copy"], timezone: "UTC",
    }), context);
    expect(JSON.parse(result.output)).toEqual({ completed: true, moved_count: 2, deleted_duplicate_count: 1 });
    const deleteIndex = calls.findIndex((call) => call.method === "delete");
    const lastMoveVerification = Math.max(...calls.map((call, index) => call.method === "get" && (call.eventId === "a" || call.eventId === "b") ? index : -1));
    expect(deleteIndex).toBeGreaterThan(lastMoveVerification);
  });

  it("rejects a bulk move that puts a prerequisite after a later lesson", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "first", summary: "Course lessons 1-2", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
      { id: "later", summary: "Course lessons 3-4", start: { dateTime: "2026-09-03T09:00:00Z" }, end: { dateTime: "2026-09-03T10:00:00Z" } },
    ]));
    const result = await plugin.run("bulk_reschedule_calendar_events", JSON.stringify({
      moves: [{ event_id: "first", new_start: "2026-09-04T09:00:00Z", new_end: "2026-09-04T10:00:00Z", sequence_group: "Course lessons" }],
      duplicate_event_ids: [], timezone: "UTC",
    }), context);
    expect(JSON.parse(result.output).error).toMatch(/breaks prerequisite order/);
    expect(calls.some((call) => call.method === "patch")).toBe(false);
  });

  it("lets an explicit null sequence_group opt out of title-based sequence inference", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "first", summary: "Course lessons 1-2", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
      { id: "later", summary: "Course lessons 3-4", start: { dateTime: "2026-09-03T09:00:00Z" }, end: { dateTime: "2026-09-03T10:00:00Z" } },
    ]));
    const result = await plugin.run("bulk_reschedule_calendar_events", JSON.stringify({
      moves: [{ event_id: "first", new_start: "2026-09-04T09:00:00Z", new_end: "2026-09-04T10:00:00Z", sequence_group: null }],
      duplicate_event_ids: [], timezone: "UTC",
    }), context);
    expect(JSON.parse(result.output)).toEqual({ completed: true, moved_count: 1, deleted_duplicate_count: 0 });
  });

  it("resolves all-day dates in the event's timezone when checking conflicts", async () => {
    const allDay = { id: "allday", summary: "Conference", start: { date: "2026-09-01" }, end: { date: "2026-09-02" } };
    const mover = { id: "move", summary: "Focus", start: { dateTime: "2026-09-05T09:00:00+10:00" }, end: { dateTime: "2026-09-05T10:00:00+10:00" } };

    const inside = await calendarPlugin(fakePort([], [allDay, mover])).run("reschedule_calendar_event", JSON.stringify({
      event_id: "move", new_start: "2026-09-01T09:00:00+10:00", new_end: "2026-09-01T10:00:00+10:00", timezone: "Australia/Sydney",
    }), context);
    expect(JSON.parse(inside.output).error).toMatch(/conflicts with existing event allday/);

    const outside = await calendarPlugin(fakePort([], [structuredClone(allDay), structuredClone(mover)])).run("reschedule_calendar_event", JSON.stringify({
      event_id: "move", new_start: "2026-09-02T09:00:00+10:00", new_end: "2026-09-02T10:00:00+10:00", timezone: "Australia/Sydney",
    }), context);
    expect(JSON.parse(outside.output).moved).toBe(true);
  });

  it("refuses to create a timed event over a busy time", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "busy", summary: "Meeting", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
    ]));
    const result = await plugin.run("create_calendar_event", JSON.stringify({
      title: "Clash", start: "2026-09-01T09:30:00Z", end: "2026-09-01T10:30:00Z",
      timezone: "UTC", description: null, location: null, attendees: [],
    }), context);
    expect(JSON.parse(result.output).error).toMatch(/conflicts with existing event busy \(Meeting\)/);
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });

  it("creates an all-day event over a busy day without a conflict check", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "busy", summary: "Meeting", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
    ]));
    const result = await plugin.run("create_calendar_event", JSON.stringify({
      title: "Conference", start: "2026-09-01", end: "2026-09-02",
      timezone: "UTC", description: null, location: null, attendees: [],
    }), context);
    expect(JSON.parse(result.output).created).toBe(true);
  });

  it("refuses an edit that moves an event onto a busy time, but not onto itself", async () => {
    const calls: RecordedCall[] = [];
    const plugin = calendarPlugin(fakePort(calls, [
      { id: "self", summary: "Focus", start: { dateTime: "2026-09-01T13:00:00Z" }, end: { dateTime: "2026-09-01T14:00:00Z" } },
      { id: "busy", summary: "Meeting", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
    ]));
    const clash = await plugin.run("edit_calendar_event", JSON.stringify({
      event_id: "self", title: null, new_start: "2026-09-01T09:30:00Z", new_end: "2026-09-01T10:30:00Z",
      timezone: "UTC", description: null, clear_description: false,
      location: null, clear_location: false, attendees: null,
    }), context);
    expect(JSON.parse(clash.output).error).toMatch(/conflicts with existing event busy/);

    const shifted = await plugin.run("edit_calendar_event", JSON.stringify({
      event_id: "self", title: null, new_start: "2026-09-01T13:30:00Z", new_end: "2026-09-01T14:30:00Z",
      timezone: "UTC", description: null, clear_description: false,
      location: null, clear_location: false, attendees: null,
    }), context);
    expect(JSON.parse(shifted.output).edited).toBe(true);
  });

  it("rolls back earlier moves when a later patch fails", async () => {
    const calls: RecordedCall[] = [];
    const base = fakePort(calls, [
      { id: "one", summary: "Block one", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
      { id: "two", summary: "Block two", start: { dateTime: "2026-09-02T09:00:00Z" }, end: { dateTime: "2026-09-02T10:00:00Z" } },
    ]);
    const patch = base.patchEvent.bind(base);
    let failed = false;
    base.patchEvent = async (eventId, body, sendUpdates) => {
      if (eventId === "two" && !failed) { failed = true; throw new Error("temporary failure"); }
      return patch(eventId, body, sendUpdates);
    };
    const result = await calendarPlugin(base).run("bulk_reschedule_calendar_events", JSON.stringify({
      moves: [
        { event_id: "one", new_start: "2026-09-04T09:00:00Z", new_end: "2026-09-04T10:00:00Z", sequence_group: null },
        { event_id: "two", new_start: "2026-09-05T09:00:00Z", new_end: "2026-09-05T10:00:00Z", sequence_group: null },
      ], duplicate_event_ids: [], timezone: "UTC",
    }), context);
    expect(JSON.parse(result.output).error).toMatch(/All applied moves were rolled back/);
    expect(calls.filter((call) => call.method === "patch" && call.eventId === "one")).toHaveLength(2);
  });

  it("declares only search_calendar as read-only and every tool as private", () => {
    const plugin = calendarPlugin(fakePort([]));
    expect(plugin.sideEffectingTools).toEqual(["set_calendar_event_color", "delete_calendar_event", "reschedule_calendar_event", "bulk_reschedule_calendar_events", "create_calendar_event", "edit_calendar_event"]);
    expect(plugin.privateTools).toEqual(["set_calendar_event_color", "search_calendar", "delete_calendar_event", "reschedule_calendar_event", "bulk_reschedule_calendar_events", "create_calendar_event", "edit_calendar_event"]);
  });
});
