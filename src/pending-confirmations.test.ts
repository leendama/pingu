import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PENDING_ACTION_TTL_MS, armPendingAction, consumeActionConfirmation, getPendingAction, isExplicitActionConfirmation } from "./pending-confirmations.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-confirm-test-"));
  process.env.PHOTON_DATA_DIR = directory;
});

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

describe("pending destructive actions", () => {
  it("fires only on an explicit yes and is disarmed by anything else", async () => {
    await armPendingAction("chat", "delete_event:evt-1", "Delete Standup", 0);
    expect(await getPendingAction("chat", 1)).toMatchObject({ key: "delete_event:evt-1" });
    expect(await consumeActionConfirmation("chat", ["actually, what time is it?"], 2)).toEqual({});
    expect(await getPendingAction("chat", 3)).toBeUndefined();

    await armPendingAction("chat", "delete_event:evt-1", "Delete Standup", 10);
    expect(await consumeActionConfirmation("chat", ["yes, delete it"], 11)).toEqual({ confirmedActionKey: "delete_event:evt-1" });
    expect(await consumeActionConfirmation("chat", ["yes"], 12)).toEqual({});
  });

  it("expires a stale confirmation", async () => {
    await armPendingAction("chat", "delete_event:evt-1", "Delete Standup", 0);
    expect(await consumeActionConfirmation("chat", ["yes"], PENDING_ACTION_TTL_MS + 1)).toEqual({});
  });

  it("recognises the confirmation phrases and nothing looser", () => {
    for (const text of ["yes", "Yes.", "delete it", "go ahead", "yes please", "confirm", "Yes, do it!"]) expect(isExplicitActionConfirmation(text)).toBe(true);
    for (const text of ["yes but move it first", "maybe", "delete everything", "no"]) expect(isExplicitActionConfirmation(text)).toBe(false);
  });
});
