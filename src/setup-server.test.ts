import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartOutcome } from "./agent-starter.js";
import { saveConfig, type AssistantConfig } from "./config.js";
import { markAgentStarted, markReplyDelivered, resetRuntimeStatus } from "./runtime-status.js";
import { createSetupServer } from "./setup-server.js";

vi.mock("./google.js", () => ({
  googleScopes: ["scope"],
  googleOAuthClient: () => ({
    generateAuthUrl: () => "https://accounts.google.example/auth",
    getToken: async () => ({ tokens: { refresh_token: "fresh-refresh-token" } }),
  }),
}));

vi.mock("./diagnostics.js", () => ({
  runDiagnostics: async () => [
    { name: "provider", label: "OpenAI", status: "ok", detail: "The key can use gpt-5.6-luna." },
    { name: "google", label: "Google Calendar and Gmail", status: "failed", detail: "Gmail permission is missing. Reconnect Google and approve every permission." },
  ],
}));

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  resetRuntimeStatus();
  for (const name of ["PHOTON_DATA_DIR", "PHOTON_CONFIG_KEY", "PHOTON_SETUP_TOKEN", "PHOTON_PUBLIC_URL", "PINGU_OWNER_SENDER_IDS"]) delete process.env[name];
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const SETUP_TOKEN = "server-test-setup-token-long-enough";

async function startServer(onReady: (config: AssistantConfig) => Promise<StartOutcome> = async () => ({ started: true })) {
  const directory = await mkdtemp(join(tmpdir(), "pingu-server-test-"));
  directories.push(directory);
  process.env.PHOTON_DATA_DIR = directory;
  process.env.PHOTON_CONFIG_KEY = "server-test-encryption-key-long-enough";
  process.env.PHOTON_SETUP_TOKEN = SETUP_TOKEN;
  process.env.PHOTON_PUBLIC_URL = "http://localhost";
  const server = createSetupServer(onReady).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, directory };
}

async function loginCookie(base: string): Promise<string> {
  const login = await fetch(`${base}/setup/login`, {
    method: "POST",
    body: new URLSearchParams({ token: SETUP_TOKEN }),
    redirect: "manual",
  });
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const savedConfig = {
  assistantName: "Pingu",
  ownerName: "Owner",
  timezone: "UTC",
  photonProjectId: "project-1",
  photonProjectSecret: "photon-secret",
  openaiApiKey: "sk-0123456789012345678901234567",
  model: "gpt-5.6-luna",
  google: { clientId: "client-original", clientSecret: "google-secret", refreshToken: "existing-refresh-token" },
};

function saveBody(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    assistantName: "Pingu", ownerName: "Owner", timezone: "UTC",
    photonProjectId: "project-1", photonProjectSecret: "", openaiApiKey: "",
    model: "gpt-5.6-luna", googleClientId: "client-original", googleClientSecret: "", granolaApiKey: "",
    ...overrides,
  });
}

function oauthState(timestamp = Date.now(), tamper = false): string {
  const nonce = "test-nonce";
  const signature = createHmac("sha256", SETUP_TOKEN).update(`${timestamp}.${nonce}`).digest("base64url");
  return `${timestamp}.${nonce}.${tamper ? "forged-signature" : signature}`;
}

describe("setup recovery", () => {
  it("keeps health and authenticated setup available with unreadable config", async () => {
    const { base, directory } = await startServer();
    await writeFile(join(directory, "config.enc.json"), "{invalid", "utf8");
    const health = await fetch(`${base}/healthz`);
    expect(await health.json()).toMatchObject({ ok: true, configured: false, googleConnected: false });
    const setup = await fetch(`${base}/setup`, { headers: { cookie: await loginCookie(base) } });
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain("Set up your assistant");
  });
});

describe("setup authentication", () => {
  it("rejects a wrong setup token", async () => {
    const { base } = await startServer();
    const login = await fetch(`${base}/setup/login`, {
      method: "POST",
      body: new URLSearchParams({ token: "not-the-real-token-but-long" }),
      redirect: "manual",
    });
    expect(login.status).toBe(401);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("rejects forged, expired, and malformed setup cookies", async () => {
    const { base } = await startServer();
    const forged = `photon_setup=${Date.now()}.forged-signature`;
    expect((await fetch(`${base}/setup`, { headers: { cookie: forged } })).status).toBe(401);

    const staleIssuedAt = String(Date.now() - 25 * 60 * 60 * 1000);
    const staleSignature = createHmac("sha256", SETUP_TOKEN).update(staleIssuedAt).digest("base64url");
    expect((await fetch(`${base}/setup`, { headers: { cookie: `photon_setup=${staleIssuedAt}.${staleSignature}` } })).status).toBe(401);

    expect((await fetch(`${base}/setup`, { headers: { cookie: "photon_setup=garbage" } })).status).toBe(401);
  });
});

describe("setup save", () => {
  it("keeps blank secrets and the refresh token when the Google client is unchanged", async () => {
    const { base } = await startServer(async () => ({ started: false, reason: "already-running" }));
    await saveConfig(savedConfig);
    const { loadConfig } = await import("./config.js");
    const response = await fetch(`${base}/setup/save`, {
      method: "POST",
      headers: { cookie: await loginCookie(base) },
      body: saveBody(),
    });
    expect(response.status).toBe(200);
    const config = await loadConfig();
    expect(config?.photonProjectSecret).toBe("photon-secret");
    expect(config?.openaiApiKey).toBe(savedConfig.openaiApiKey);
    expect(config?.google.refreshToken).toBe("existing-refresh-token");
  });

  it("clears the refresh token when the Google client ID changes", async () => {
    const { base } = await startServer(async () => ({ started: false, reason: "already-running" }));
    await saveConfig(savedConfig);
    const { loadConfig } = await import("./config.js");
    const response = await fetch(`${base}/setup/save`, {
      method: "POST",
      headers: { cookie: await loginCookie(base) },
      body: saveBody({ googleClientId: "client-replacement" }),
    });
    expect(await response.text()).toContain("Connect Google to finish.");
    expect((await loadConfig())?.google.refreshToken).toBeUndefined();
  });

  it("shows the real startup failure instead of claiming the assistant is running", async () => {
    const { base } = await startServer(async () => ({ started: false, reason: "startup-failed", message: "Photon authentication failed" }));
    await saveConfig(savedConfig);
    const response = await fetch(`${base}/setup/save`, {
      method: "POST",
      headers: { cookie: await loginCookie(base) },
      body: saveBody(),
    });
    const html = await response.text();
    expect(html).toContain("Saved, but the assistant could not start: Photon authentication failed");
    expect(html).not.toContain("Saved and running.");
  });
});

describe("health endpoint privacy", () => {
  it("reports activity as booleans, never as timestamps", async () => {
    const { base } = await startServer();
    markAgentStarted(new Date("2026-09-02T10:00:00Z"));
    markReplyDelivered(new Date("2026-09-02T10:05:00Z"));
    const health = await (await fetch(`${base}/healthz`)).json() as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, running: true, hasDeliveredReply: true });
    expect(JSON.stringify(health)).not.toContain("2026-09-02");
    expect(health.startedAt).toBeUndefined();
    expect(health.lastReplyAt).toBeUndefined();
  });
});

describe("connection tests", () => {
  it("renders each check with its plain-language outcome", async () => {
    const { base } = await startServer();
    await saveConfig(savedConfig);
    const response = await fetch(`${base}/setup/test`, { method: "POST", headers: { cookie: await loginCookie(base) } });
    const html = await response.text();
    expect(html).toContain("Connection tests");
    expect(html).toContain("The key can use gpt-5.6-luna.");
    expect(html).toContain("Gmail permission is missing");
  });

  it("requires authentication", async () => {
    const { base } = await startServer();
    expect((await fetch(`${base}/setup/test`, { method: "POST" })).status).toBe(401);
  });
});

describe("google oauth callback", () => {
  it("rejects tampered and expired state", async () => {
    const { base } = await startServer();
    await saveConfig(savedConfig);
    const tampered = await fetch(`${base}/auth/google/callback?code=abc&state=${encodeURIComponent(oauthState(Date.now(), true))}`);
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).toContain("state is invalid or expired");

    const expired = await fetch(`${base}/auth/google/callback?code=abc&state=${encodeURIComponent(oauthState(Date.now() - 11 * 60 * 1000))}`);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("state is invalid or expired");
  });

  it("stores the refresh token and redirects home when the agent starts", async () => {
    const { base } = await startServer(async () => ({ started: true }));
    await saveConfig({ ...savedConfig, google: { ...savedConfig.google, refreshToken: undefined } });
    const { loadConfig } = await import("./config.js");
    const callback = await fetch(`${base}/auth/google/callback?code=abc&state=${encodeURIComponent(oauthState())}`, { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/setup");
    expect((await loadConfig())?.google.refreshToken).toBe("fresh-refresh-token");
  });

  it("carries a startup failure through the redirect instead of a generic restart hint", async () => {
    const { base } = await startServer(async () => ({ started: false, reason: "startup-failed", message: "Photon authentication failed" }));
    await saveConfig(savedConfig);
    const callback = await fetch(`${base}/auth/google/callback?code=abc&state=${encodeURIComponent(oauthState())}`, { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`/setup?failed=${encodeURIComponent("Photon authentication failed")}`);

    const setupPage = await fetch(`${base}${callback.headers.get("location")}`, { headers: { cookie: await loginCookie(base) } });
    expect(await setupPage.text()).toContain("Google connected, but the assistant could not start: Photon authentication failed");
  });
});

describe("owner claim codes", () => {
  it("shows a claim code behind the login and lists verified owners", async () => {
    const { base } = await startServer();
    const cookie = await loginCookie(base);
    const before = await (await fetch(`${base}/setup`, { headers: { cookie } })).text();
    expect(before).toContain("No verified owner yet");
    const claimed = await (await fetch(`${base}/setup/claim`, { method: "POST", headers: { cookie } })).text();
    const code = claimed.match(/PINGU-[A-Z0-9]{6}/)?.[0];
    expect(code).toBeDefined();
    const { redeemClaimCode } = await import("./owners.js");
    expect(await redeemClaimCode(code!, { senderId: "+15550101000", spaceId: "dm" })).toBe("verified");
    const after = await (await fetch(`${base}/setup`, { headers: { cookie } })).text();
    expect(after).toContain("+15550101000");
    const removed = await (await fetch(`${base}/setup/owners/remove`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ senderId: "+15550101000" }) })).text();
    expect(removed).toContain("Owner removed");
  });

  it("requires authentication to issue a code", async () => {
    const { base } = await startServer();
    expect((await fetch(`${base}/setup/claim`, { method: "POST" })).status).toBe(401);
  });
});

describe("delete all data", () => {
  it("refuses without the typed confirmation and deletes with it", async () => {
    const { base, directory } = await startServer();
    const cookie = await loginCookie(base);
    await writeFile(join(directory, "reminders.json"), "[]", "utf8");
    const refused = await fetch(`${base}/setup/data/delete`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ confirm: "delete" }) });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Nothing was deleted");
    const deleted = await (await fetch(`${base}/setup/data/delete`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ confirm: "DELETE" }) })).text();
    expect(deleted).toContain("1 data file(s)");
  });
});

describe("saved settings", () => {
  it("stores endpoint, guest, booking, and privacy settings with checkbox semantics", async () => {
    const { base } = await startServer(async () => ({ started: false, reason: "already-running" }));
    await saveConfig(savedConfig);
    const { loadConfig } = await import("./config.js");
    await fetch(`${base}/setup/save`, {
      method: "POST",
      headers: { cookie: await loginCookie(base) },
      body: saveBody({ openaiBaseUrl: "http://host.docker.internal:11434/v1", bookableHours: "24h", bookableDays: "all", guestDailyMessageCap: "5", transcriptRetentionDays: "0", defaultMeetingMinutes: "45", telemetry: "on" }),
    });
    const config = await loadConfig();
    expect(config).toMatchObject({ openaiBaseUrl: "http://host.docker.internal:11434/v1", bookableHours: "24h", bookableDays: "all", guestDailyMessageCap: 5, transcriptRetentionDays: 0, defaultMeetingMinutes: 45, telemetry: true, meetLink: false });
  });

  it("rejects an endpoint that is not a URL", async () => {
    const { base } = await startServer();
    await saveConfig(savedConfig);
    const response = await fetch(`${base}/setup/save`, {
      method: "POST",
      headers: { cookie: await loginCookie(base) },
      body: saveBody({ openaiBaseUrl: "ollama" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("full http(s) URL");
  });
});
