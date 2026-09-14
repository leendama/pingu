import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolRunContext } from "../plugins.js";
import { cancelReminder, countRemindersBySender, createReminder, listReminders } from "../reminders.js";
import { remindersPlugin } from "./reminders.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-reminders-test-"));
  process.env.PHOTON_DATA_DIR = directory;
});

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

const store = { create: createReminder, list: listReminders, cancel: cancelReminder, countBySender: countRemindersBySender };
const due = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function context(overrides: Partial<ToolRunContext>): ToolRunContext {
  return { spaceId: "group-1", isGroup: true, role: "guest", senderId: "guest-a", config: { timezone: "UTC" }, sideEffectAttempted: false, untrustedContentSeen: false, ...overrides } as ToolRunContext;
}

async function create(plugin: ReturnType<typeof remindersPlugin>, ctx: ToolRunContext, text = "call mum") {
  return JSON.parse((await plugin.run("create_reminder", JSON.stringify({ text, due_at: due, recurrence: "none", timezone: "UTC" }), ctx)).output);
}

describe("reminders and identity", () => {
  it("caps a guest by sender across every chat", async () => {
    const plugin = remindersPlugin(store, { guestMaxReminders: 2 });
    expect((await create(plugin, context({ spaceId: "dm-a" }))).created).toBe(true);
    expect((await create(plugin, context({ spaceId: "group-1" }))).created).toBe(true);
    expect((await create(plugin, context({ spaceId: "group-2" }))).error).toMatch(/at most 2/);
    expect((await create(plugin, context({ spaceId: "group-2", senderId: "guest-b" }))).created).toBe(true);
    expect((await create(plugin, context({ spaceId: "dm", senderId: undefined }))).error).toMatch(/can't tell who/);
  });

  it("shows and cancels reminders only for the person who created them", async () => {
    const plugin = remindersPlugin(store);
    const mine = await create(plugin, context({}), "mine");
    await create(plugin, context({ senderId: "guest-b" }), "theirs");
    const listed = JSON.parse((await plugin.run("list_reminders", "{}", context({}))).output).reminders as Array<{ text: string }>;
    expect(listed.map((reminder) => reminder.text)).toEqual(["mine"]);
    const theirs = (await listReminders("group-1")).find((reminder) => reminder.text === "theirs")!;
    const denied = JSON.parse((await plugin.run("cancel_reminder", JSON.stringify({ reminder_id: theirs.id }), context({}))).output);
    expect(denied.cancelled).toBe(false);
    const allowed = JSON.parse((await plugin.run("cancel_reminder", JSON.stringify({ reminder_id: mine.reminder.id }), context({}))).output);
    expect(allowed.cancelled).toBe(true);
    expect(await listReminders("group-1")).toHaveLength(1);
  });

  it("treats reminders without a creator as the owner's", async () => {
    const legacy = await createReminder({ spaceId: "dm", text: "old", dueAt: due, recurrence: "none", timezone: "UTC" });
    expect(await listReminders("dm", { role: "guest", senderId: "g" })).toEqual([]);
    expect((await listReminders("dm", { role: "owner", senderId: "o" })).map((reminder) => reminder.id)).toEqual([legacy.id]);
  });

  it("enforces the sender cap inside the same transaction as the insert", async () => {
    await expect(Promise.all([
      createReminder({ spaceId: "a", text: "1", dueAt: due, recurrence: "none", timezone: "UTC", creatorSenderId: "racer" }, { maxForSender: 1 }),
      createReminder({ spaceId: "b", text: "2", dueAt: due, recurrence: "none", timezone: "UTC", creatorSenderId: "racer" }, { maxForSender: 1 }),
    ])).rejects.toThrow(/at most 1/);
    expect(await countRemindersBySender("racer")).toBe(1);
  });
});
