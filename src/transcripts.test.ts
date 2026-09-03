import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { appendTranscript, cleanupTranscripts, compactEntries, deleteAllPinguData, forgetTranscript, readTranscript, type TranscriptEntry } from "./transcripts.js";

let directory: string;
const settings = { retentionDays: 30, maxEntries: 80, maxChars: 60_000 };
const now = Date.parse("2026-09-02T10:00:00Z");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-transcripts-test-"));
  process.env.PHOTON_DATA_DIR = directory;
});

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

const user = (text: string): ResponseInputItem => ({ type: "message", role: "user", content: text });
const call = (id: string): ResponseInputItem => ({ type: "function_call", call_id: id, name: "get_current_time", arguments: "{}" });
const output = (id: string): ResponseInputItem => ({ type: "function_call_output", call_id: id, output: "{}" });
const at = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();

describe("compactEntries", () => {
  it("drops entries older than the retention window", () => {
    const entries: TranscriptEntry[] = [
      { at: at(40), item: user("old") },
      { at: at(1), item: user("recent") },
    ];
    expect(compactEntries(entries, settings, now).map((entry) => entry.item)).toEqual([user("recent")]);
  });

  it("always cuts at a user message so a tool call never survives without its output", () => {
    const entries: TranscriptEntry[] = [
      { at: at(1), item: user("first") },
      { at: at(1), item: call("c1") },
      { at: at(1), item: output("c1") },
      { at: at(1), item: user("second") },
    ];
    const kept = compactEntries(entries, { ...settings, maxEntries: 3 }, now);
    expect(kept.map((entry) => entry.item)).toEqual([user("second")]);
  });

  it("respects the character budget", () => {
    const entries: TranscriptEntry[] = [
      { at: at(1), item: user("x".repeat(500)) },
      { at: at(1), item: user("short") },
    ];
    expect(compactEntries(entries, { ...settings, maxChars: 200 }, now).map((entry) => entry.item)).toEqual([user("short")]);
  });

  it("keeps nothing between messages when retention is zero", () => {
    expect(compactEntries([{ at: at(0.5), item: user("today") }], { ...settings, retentionDays: 0 }, now)).toEqual([]);
  });
});

describe("transcript files", () => {
  it("round-trips per space, forgets one chat, and deletes everything", async () => {
    await appendTranscript("space-a", [user("hello")], settings, now);
    await appendTranscript("space-b", [user("other")], settings, now);
    expect(await readTranscript("space-a", settings, now)).toEqual([user("hello")]);
    expect(await readTranscript("space-b", settings, now)).toEqual([user("other")]);
    expect((await readdir(join(directory, "transcripts"))).length).toBe(2);

    await forgetTranscript("space-a");
    expect(await readTranscript("space-a", settings, now)).toEqual([]);
    expect(await readTranscript("space-b", settings, now)).toEqual([user("other")]);
    expect((await readdir(join(directory, "transcripts"))).length).toBe(1);

    await writeFile(join(directory, "reminders.json"), "[]");
    const result = await deleteAllPinguData();
    expect(result.transcripts).toBe(1);
    expect(result.files).toEqual(["reminders.json"]);
    expect(await readTranscript("space-b", settings, now)).toEqual([]);
  });

  it("tolerates a corrupt transcript file by starting fresh", async () => {
    await appendTranscript("space-c", [user("hello")], settings, now);
    const [file] = await readdir(join(directory, "transcripts"));
    await writeFile(join(directory, "transcripts", file!), JSON.stringify({ version: 1, entries: "nonsense" }));
    expect(await readTranscript("space-c", settings, now)).toEqual([]);
  });

  it("removes expired history from disk on read, not only from the reply", async () => {
    await appendTranscript("space-d", [user("old")], settings, now - 40 * 24 * 60 * 60 * 1000);
    const [file] = await readdir(join(directory, "transcripts"));
    expect(await readFile(join(directory, "transcripts", file!), "utf8")).toContain("old");
    expect(await readTranscript("space-d", settings, now)).toEqual([]);
    expect(await readFile(join(directory, "transcripts", file!), "utf8")).not.toContain("old");
  });

  it("cleans up chats that never receive another message", async () => {
    await appendTranscript("quiet", [user("long ago")], settings, now - 40 * 24 * 60 * 60 * 1000);
    await appendTranscript("active", [user("recent")], settings, now);
    await writeFile(join(directory, "transcripts", "stray.json"), "not json");
    const result = await cleanupTranscripts(settings, now);
    expect(result).toEqual({ trimmed: 0, deleted: 2 });
    expect(await readdir(join(directory, "transcripts"))).toHaveLength(1);
    expect(await readTranscript("active", settings, now)).toEqual([user("recent")]);
  });
});
