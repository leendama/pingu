import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConversationId, setConversationId } from "./conversations.js";

let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "photon-conversation-test-"));
  process.env.PHOTON_DATA_DIR = dataDirectory;
});

afterAll(async () => {
  delete process.env.PHOTON_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("conversation state", () => {
  it("re-reads manual state changes", async () => {
    await setConversationId("chat", "conversation-1");
    await writeFile(join(dataDirectory, "conversations.json"), JSON.stringify({ chat: "conversation-2" }));
    expect(await getConversationId("chat")).toBe("conversation-2");
  });
});
