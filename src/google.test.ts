import { describe, expect, it } from "vitest";
import { availabilityOnlyCalendarEvent, googleClient, readOnlyCalendarIds } from "./google.js";

describe("Google adapter", () => {
  it("reuses one authenticated client for the same credentials", async () => {
    const credentials = {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      redirectUri: "http://localhost/callback",
    };
    expect(await googleClient(credentials)).toBe(await googleClient(credentials));
  });
});

describe("read-only availability calendars", () => {
  it("parses unique non-primary calendar IDs", () => {
    expect(readOnlyCalendarIds(" primary, work@example.com, work@example.com, team@example.com ")).toEqual(["work@example.com", "team@example.com"]);
  });

  it("strips action IDs and private fields from availability events", () => {
    expect(availabilityOnlyCalendarEvent({ id: "private-id", summary: "Work", start: { dateTime: "2029-02-05T10:00:00Z" }, end: { dateTime: "2029-02-05T11:00:00Z" }, description: "private", attendees: [{ email: "person@example.com" }] })).toEqual({ summary: "Work", start: { dateTime: "2029-02-05T10:00:00Z" }, end: { dateTime: "2029-02-05T11:00:00Z" }, readOnly: true });
  });
});
