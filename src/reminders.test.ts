import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReminder, listReminders, nextDueAt, startReminderScheduler, type Reminder } from "./reminders.js";

let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "photon-reminder-test-"));
  process.env.PHOTON_DATA_DIR = dataDirectory;
});

afterAll(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

function daily(dueAt: string): Reminder {
  return {
    id: "reminder",
    spaceId: "chat",
    text: "Daily check-in",
    dueAt,
    recurrence: "daily",
    timezone: "America/New_York",
    createdAt: dueAt,
  };
}

describe("reminder recurrence", () => {
  it("preserves wall-clock time when daylight saving ends", () => {
    expect(nextDueAt(daily("2026-10-31T13:00:00.000Z"), Date.parse("2026-10-31T13:00:01Z")))
      .toBe("2026-11-01T14:00:00.000Z");
  });

  it("preserves wall-clock time when daylight saving begins", () => {
    expect(nextDueAt(daily("2026-03-07T14:00:00.000Z"), Date.parse("2026-03-07T14:00:01Z")))
      .toBe("2026-03-08T13:00:00.000Z");
  });

  it("does not lose concurrent reminder creations", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => createReminder({
      spaceId: "concurrent",
      text: `Reminder ${index}`,
      dueAt: "2030-01-01T00:00:00.000Z",
      recurrence: "none",
      timezone: "UTC",
    })));
    expect(await listReminders("concurrent")).toHaveLength(20);
  });

  it("rejects an invalid timezone when the reminder is created", async () => {
    await expect(createReminder({
      spaceId: "invalid-timezone",
      text: "Never duplicate me",
      dueAt: "2030-01-01T00:00:00.000Z",
      recurrence: "daily",
      timezone: "Mars/Olympus_Mons",
    })).rejects.toThrow(/timezone is invalid/);
  });

  it("disables a legacy invalid reminder before delivery", async () => {
    const path = join(dataDirectory, "reminders.json");
    const reminders = JSON.parse(await readFile(path, "utf8")) as Reminder[];
    reminders.push({
      id: "legacy-invalid",
      spaceId: "legacy",
      text: "Do not redeliver",
      dueAt: "2020-01-01T00:00:00.000Z",
      recurrence: "daily",
      timezone: "Mars/Olympus_Mons",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    await writeFile(path, JSON.stringify(reminders));
    const deliver = vi.fn(async () => undefined);
    const stop = startReminderScheduler(deliver, 60_000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await listReminders("legacy"))[0]?.disabledAt) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();
    expect(deliver).not.toHaveBeenCalled();
    expect((await listReminders("legacy"))[0]?.disabledAt).toBeTruthy();
  });
});
