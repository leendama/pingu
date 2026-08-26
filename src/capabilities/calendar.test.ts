import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "../plugins.js";
import { calendarPlugin, type CalendarPort } from "./calendar.js";

interface RecordedCall {
  method: "list" | "insert" | "patch" | "delete";
  eventId?: string;
  requestBody?: Record<string, unknown>;
  sendUpdates?: "all" | "none";
}

function fakePort(calls: RecordedCall[]): CalendarPort {
  return {
    async listEvents() {
      calls.push({ method: "list" });
      return [{ id: "evt-1" }];
    },
    async insertEvent(requestBody, sendUpdates) {
      calls.push({ method: "insert", requestBody, sendUpdates });
      return { id: "evt-new", summary: String(requestBody.summary) };
    },
    async patchEvent(eventId, requestBody, sendUpdates) {
      calls.push({ method: "patch", eventId, requestBody, sendUpdates });
      return { id: eventId };
    },
    async deleteEvent(eventId, sendUpdates) {
      calls.push({ method: "delete", eventId, sendUpdates });
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
    expect(calls[0]).toMatchObject({
      method: "insert",
      sendUpdates: "none",
      requestBody: { start: { dateTime: "2026-09-01T09:00:00", timeZone: "UTC" } },
    });

    await plugin.run("create_calendar_event", JSON.stringify({
      title: "Review", start: "2026-09-01T10:00:00", end: "2026-09-01T11:00:00",
      timezone: "UTC", description: null, location: null, attendees: ["a@example.com"],
    }), context);
    expect(calls[1]).toMatchObject({ method: "insert", sendUpdates: "all" });
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

  it("declares only search_calendar as read-only and every tool as private", () => {
    const plugin = calendarPlugin(fakePort([]));
    expect(plugin.sideEffectingTools).toEqual(["delete_calendar_event", "reschedule_calendar_event", "create_calendar_event", "edit_calendar_event"]);
    expect(plugin.privateTools).toEqual(["search_calendar", "delete_calendar_event", "reschedule_calendar_event", "create_calendar_event", "edit_calendar_event"]);
  });
});
