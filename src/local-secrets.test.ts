import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLocalSecrets, setupLink } from "./local-secrets.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pingu-secrets-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("local secrets", () => {
  it("generates a persistent config key and a per-run setup token on localhost", async () => {
    const env: NodeJS.ProcessEnv = { PHOTON_DATA_DIR: directory };
    const saved = process.env.PHOTON_DATA_DIR;
    process.env.PHOTON_DATA_DIR = directory;
    try {
      const first = await ensureLocalSecrets(env);
      expect(first).toEqual({ generatedToken: true, generatedKey: true });
      expect(env.PHOTON_CONFIG_KEY!.length).toBeGreaterThanOrEqual(24);
      expect(env.PHOTON_SETUP_TOKEN!.length).toBeGreaterThanOrEqual(20);
      expect((await readFile(join(directory, "config-key"), "utf8")).trim()).toBe(env.PHOTON_CONFIG_KEY);
      const again: NodeJS.ProcessEnv = { PHOTON_DATA_DIR: directory };
      const second = await ensureLocalSecrets(again);
      expect(second).toEqual({ generatedToken: true, generatedKey: false });
      expect(again.PHOTON_CONFIG_KEY).toBe(env.PHOTON_CONFIG_KEY);
      expect(again.PHOTON_SETUP_TOKEN).not.toBe(env.PHOTON_SETUP_TOKEN);
      expect(setupLink(again)).toBe(`http://localhost:3000/setup/enter?token=${encodeURIComponent(again.PHOTON_SETUP_TOKEN!)}`);
    } finally {
      if (saved === undefined) delete process.env.PHOTON_DATA_DIR; else process.env.PHOTON_DATA_DIR = saved;
    }
  });

  it("never invents secrets for a public host", async () => {
    const env: NodeJS.ProcessEnv = { PHOTON_PUBLIC_URL: "https://pingu.example.com" };
    expect(await ensureLocalSecrets(env)).toEqual({ generatedToken: false, generatedKey: false });
    expect(env.PHOTON_SETUP_TOKEN).toBeUndefined();
    expect(env.PHOTON_CONFIG_KEY).toBeUndefined();
  });

  it("keeps explicit secrets when they are already set", async () => {
    const env: NodeJS.ProcessEnv = { PHOTON_SETUP_TOKEN: "explicit-token-that-is-long", PHOTON_CONFIG_KEY: "explicit-config-key-long-enough" };
    expect(await ensureLocalSecrets(env)).toEqual({ generatedToken: false, generatedKey: false });
    expect(env.PHOTON_SETUP_TOKEN).toBe("explicit-token-that-is-long");
  });
});
