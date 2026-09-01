import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSetupServer } from "./setup-server.js";

const directories: string[] = [];

afterEach(async () => {
  for (const name of ["PHOTON_DATA_DIR", "PHOTON_CONFIG_KEY", "PHOTON_SETUP_TOKEN", "PHOTON_PUBLIC_URL"]) delete process.env[name];
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("setup recovery", () => {
  it("keeps health and authenticated setup available with unreadable config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-server-test-"));
    directories.push(directory);
    process.env.PHOTON_DATA_DIR = directory;
    process.env.PHOTON_CONFIG_KEY = "server-test-encryption-key-long-enough";
    process.env.PHOTON_SETUP_TOKEN = "server-test-setup-token-long-enough";
    process.env.PHOTON_PUBLIC_URL = "http://localhost";
    await writeFile(join(directory, "config.enc.json"), "{invalid", "utf8");
    const server = createSetupServer(() => ({ started: true })).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await health.json()).toMatchObject({ ok: true, configured: false, googleConnected: false });
      const login = await fetch(`http://127.0.0.1:${port}/setup/login`, {
        method: "POST",
        body: new URLSearchParams({ token: process.env.PHOTON_SETUP_TOKEN }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      const setup = await fetch(`http://127.0.0.1:${port}/setup`, { headers: { cookie: cookie ?? "" } });
      expect(setup.status).toBe(200);
      expect(await setup.text()).toContain("Set up your assistant");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
