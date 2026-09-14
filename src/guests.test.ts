import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitGuestMessage, firstContactDisclosure, guestLimitMessage, guestTooLongMessage, guestUsageToday, recordGuestUsage, releaseGuestReservation, resetGuestReservations } from "./guests.js";

let directory: string;
const settings = { dailyMessageCap: 2, dailyTokenBudget: 100, maxReminders: 5, maxInboundChars: 2000, maxTurnTokens: 30, maxToolRounds: 4, maxOutputTokens: 500 };
const day1 = Date.parse("2026-09-02T10:00:00Z");
const day2 = Date.parse("2026-09-03T10:00:00Z");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-guests-test-"));
  process.env.PHOTON_DATA_DIR = directory;
});

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

describe("guest limits", () => {
  it("reports first contact once and caps a sender per day", async () => {
    expect(await admitGuestMessage("g1", settings, { now: day1 })).toEqual({ allowed: true, firstContact: true, remaining: 1 });
    expect(await admitGuestMessage("g1", settings, { now: day1 })).toEqual({ allowed: true, firstContact: false, remaining: 0 });
    expect(await admitGuestMessage("g1", settings, { now: day1 })).toEqual({ allowed: false, firstContact: false, reason: "sender-cap" });
    expect(await admitGuestMessage("g1", settings, { now: day2 })).toEqual({ allowed: true, firstContact: false, remaining: 1 });
  });

  it("does not let many senders bypass the global daily budget", async () => {
    await recordGuestUsage(60, day1);
    await recordGuestUsage(50, day1);
    expect(await guestUsageToday(day1)).toMatchObject({ tokens: 110 });
    expect(await admitGuestMessage("g2", settings, { now: day1 })).toEqual({ allowed: false, firstContact: true, reason: "budget" });
    expect(await admitGuestMessage("g3", settings, { now: day1 })).toMatchObject({ allowed: false, reason: "budget" });
    expect(await admitGuestMessage("g2", settings, { now: day2 })).toMatchObject({ allowed: true });
  });

  it("counts every message in a burst against the sender's cap and refuses a burst that would pass it", async () => {
    expect(await admitGuestMessage("g4", settings, { now: day1, messages: 2 })).toEqual({ allowed: true, firstContact: true, remaining: 0 });
    expect(await admitGuestMessage("g4", settings, { now: day1 })).toMatchObject({ allowed: false, reason: "sender-cap" });
    expect(await admitGuestMessage("g5", settings, { now: day1 })).toMatchObject({ allowed: true, remaining: 1 });
    expect(await admitGuestMessage("g5", settings, { now: day1, messages: 10 })).toMatchObject({ allowed: false, reason: "sender-cap" });
    expect(await admitGuestMessage("g5", settings, { now: day1, messages: 1 })).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("drops reservations left behind by a crash", async () => {
    await admitGuestMessage("a", settings, { now: day1, reserveTokens: 90 });
    expect(await admitGuestMessage("b", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: false, reason: "budget" });
    await resetGuestReservations();
    expect(await guestUsageToday(day1)).toMatchObject({ reserved: 0 });
    expect(await admitGuestMessage("b", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: true });
  });

  it("reserves an estimated turn cost so simultaneous guests cannot overshoot the budget together", async () => {
    // Budget 100, each turn reserves 30: three turns fit, the fourth is refused until one releases.
    expect(await admitGuestMessage("a", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: true });
    expect(await admitGuestMessage("b", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: true });
    expect(await admitGuestMessage("c", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: true });
    expect(await admitGuestMessage("d", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: false, reason: "budget" });
    expect(await guestUsageToday(day1)).toMatchObject({ reserved: 90 });
    await releaseGuestReservation(30, day1);
    await recordGuestUsage(5, day1);
    expect(await guestUsageToday(day1)).toMatchObject({ reserved: 60, tokens: 5 });
    expect(await admitGuestMessage("d", settings, { now: day1, reserveTokens: 30 })).toMatchObject({ allowed: true });
  });

  it("writes the messages people see in plain language", () => {
    expect(guestLimitMessage("sender-cap", "Pingu")).toContain("message limit");
    expect(guestLimitMessage("budget", "Pingu")).toContain("resting");
    expect(firstContactDisclosure("Pingu", "Alex")).toContain("Alex's assistant");
    expect(firstContactDisclosure("Pingu", "Alex")).toContain("can't share anything else");
    expect(guestTooLongMessage(2000)).toContain("2,000");
  });
});
