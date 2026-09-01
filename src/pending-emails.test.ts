import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumePendingEmailConfirmation,
  getPendingEmail,
  markPendingEmailReviewed,
  PENDING_EMAIL_TTL_MS,
  setPendingEmail,
} from "./pending-emails.js";

let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "photon-email-test-"));
  process.env.PHOTON_DATA_DIR = dataDirectory;
});

afterAll(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

async function storeDraft(spaceId = "chat"): Promise<void> {
  await setPendingEmail({
    spaceId,
    draftId: `draft-${spaceId}`,
    to: ["friend@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "Full draft body",
    createdAt: new Date().toISOString(),
  });
}

describe("pending email confirmation", () => {
  it("rejects confirmation until the full draft has been marked delivered", async () => {
    await storeDraft("unseen");
    const result = await consumePendingEmailConfirmation("unseen", "yes");
    expect(result.confirmedDraftId).toBeUndefined();
  });

  it("accepts an explicit next-message confirmation after review", async () => {
    await storeDraft("reviewed");
    await markPendingEmailReviewed("reviewed", "draft-reviewed");
    const result = await consumePendingEmailConfirmation("reviewed", "send it");
    expect(result.confirmedDraftId).toBe("draft-reviewed");
  });

  it("requires re-review after an intervening message", async () => {
    await storeDraft("intervened");
    await markPendingEmailReviewed("intervened", "draft-intervened");
    await consumePendingEmailConfirmation("intervened", "change the subject");
    const result = await consumePendingEmailConfirmation("intervened", "yes");
    expect(result.confirmedDraftId).toBeUndefined();
  });

  it("expires the confirmation window after 30 minutes", async () => {
    await storeDraft("expired");
    await markPendingEmailReviewed("expired", "draft-expired");
    const result = await consumePendingEmailConfirmation("expired", "yes", Date.now() + 31 * 60 * 1000);
    expect(result.confirmedDraftId).toBeUndefined();
  });

  it("accepts a confirmation inside a burst of consecutive messages", async () => {
    await storeDraft("burst");
    await markPendingEmailReviewed("burst", "draft-burst");
    const result = await consumePendingEmailConfirmation("burst", ["send it", "also grab milk on the way home"]);
    expect(result.confirmedDraftId).toBe("draft-burst");
  });

  it("sweeps an abandoned draft after its time-to-live", async () => {
    await storeDraft("abandoned");
    await markPendingEmailReviewed("abandoned", "draft-abandoned");
    const result = await consumePendingEmailConfirmation("abandoned", "yes", Date.now() + PENDING_EMAIL_TTL_MS + 1000);
    expect(result).toEqual({});
    expect(await getPendingEmail("abandoned")).toBeUndefined();
  });

  it("skips the file write when no confirmation window is armed", async () => {
    await storeDraft("quiet");
    await consumePendingEmailConfirmation("quiet", "first unrelated message");
    const before = await stat(join(dataDirectory, "pending-emails.json"));
    await consumePendingEmailConfirmation("quiet", "second unrelated message");
    const after = await stat(join(dataDirectory, "pending-emails.json"));
    expect(after.ino).toBe(before.ino);
  });
});
