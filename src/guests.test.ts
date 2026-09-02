import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitGuestMessage, firstContactDisclosure, guestLimitMessage, guestUsageToday, recordGuestUsage } from "./guests.js";

let directory: string;
const settings = { dailyMessageCap: 2, dailyTokenBudget: 100, maxReminders: 5 };
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
    expect(await admitGuestMessage("g1", settings, day1)).toEqual({ allowed: true, firstContact: true, remaining: 1 });
    expect(await admitGuestMessage("g1", settings, day1)).toEqual({ allowed: true, firstContact: false, remaining: 0 });
    expect(await admitGuestMessage("g1", settings, day1)).toEqual({ allowed: false, firstContact: false, reason: "sender-cap" });
    expect(await admitGuestMessage("g1", settings, day2)).toEqual({ allowed: true, firstContact: false, remaining: 1 });
  });

  it("does not let many senders bypass the global daily budget", async () => {
    await recordGuestUsage(60, day1);
    await recordGuestUsage(50, day1);
    expect(await guestUsageToday(day1)).toMatchObject({ tokens: 110 });
    expect(await admitGuestMessage("g2", settings, day1)).toEqual({ allowed: false, firstContact: true, reason: "budget" });
    expect(await admitGuestMessage("g3", settings, day1)).toMatchObject({ allowed: false, reason: "budget" });
    expect(await admitGuestMessage("g2", settings, day2)).toMatchObject({ allowed: true });
  });

  it("writes the messages people see in plain language", () => {
    expect(guestLimitMessage("sender-cap", "Pingu")).toContain("message limit");
    expect(guestLimitMessage("budget", "Pingu")).toContain("resting");
    expect(firstContactDisclosure("Pingu", "Alex")).toContain("Alex's assistant");
    expect(firstContactDisclosure("Pingu", "Alex")).toContain("can't share anything else");
  });
});
