import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "./config.js";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.PHOTON_DATA_DIR;
  delete process.env.PHOTON_CONFIG_KEY;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("encrypted configuration", () => {
  it("round-trips without writing secrets as plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-config-test-"));
    directories.push(directory);
    process.env.PHOTON_DATA_DIR = directory;
    process.env.PHOTON_CONFIG_KEY = "a-test-key-that-is-long-enough-to-use";
    const config = {
      assistantName: "Pingu",
      ownerName: "Test User",
      timezone: "UTC",
      photonProjectId: "project",
      photonProjectSecret: "photon-secret",
      openaiApiKey: "test-openai-api-key-long-enough",
      model: "gpt-5.6-luna",
      google: { clientId: "client-id", clientSecret: "secret", refreshToken: "refresh-token" },
    };
    await saveConfig(config);
    expect(await loadConfig()).toMatchObject(config);
    expect(await readFile(join(directory, "config.enc.json"), "utf8")).not.toContain("photon-secret");
  });
});
