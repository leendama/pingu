import { describe, expect, it } from "vitest";
import { runDiagnostics, type DiagnosticsProbes } from "./diagnostics.js";
import type { ProviderCapabilities } from "./provider.js";

const google = { clientId: "client-1", clientSecret: "secret", refreshToken: "token" };

const allScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    kind: "openai", modelListing: true, response: true, functionCalling: true, toolContinuation: true,
    reasoningParameters: true, voice: true, problems: [], ...overrides,
  };
}

function probes(overrides: Partial<DiagnosticsProbes> = {}): DiagnosticsProbes {
  return {
    provider: async () => capabilities(),
    googleScopes: async () => allScopes,
    googleCalendar: async () => undefined,
    granola: async () => undefined,
    ...overrides,
  };
}

const input = { openaiApiKey: "sk-test", model: "gpt-5.6-luna", granolaApiKey: "gr-key", google };

function byName(checks: Awaited<ReturnType<typeof runDiagnostics>>, name: string) {
  return checks.find((check) => check.name === name)!;
}

describe("runDiagnostics", () => {
  it("reports everything healthy when every probe passes", async () => {
    const checks = await runDiagnostics(input, probes());
    expect(byName(checks, "provider").status).toBe("ok");
    expect(byName(checks, "provider").detail).toContain("function calling");
    expect(byName(checks, "google").status).toBe("ok");
    expect(byName(checks, "granola").status).toBe("ok");
  });

  it("says an API key was rejected on a 401 and names a missing model on a 404", async () => {
    const unauthorized = await runDiagnostics(input, probes({
      provider: async () => capabilities({ response: false, functionCalling: false, toolContinuation: false, problems: ["Basic response failed: 401 Unauthorized"] }),
    }));
    expect(byName(unauthorized, "provider")).toMatchObject({ status: "failed", detail: expect.stringContaining("Check the API key") });

    const missingModel = await runDiagnostics(input, probes({
      provider: async () => capabilities({ response: false, functionCalling: false, toolContinuation: false, problems: ["Basic response failed: 404 model not found"] }),
    }));
    expect(byName(missingModel, "provider").detail).toContain('Check that the model "gpt-5.6-luna" exists');
  });

  it("fails a compatible endpoint that cannot call tools and says what Pingu needs", async () => {
    const checks = await runDiagnostics({ ...input, openaiBaseUrl: "http://localhost:11434/v1" }, probes({
      provider: async () => capabilities({ kind: "compatible", voice: false, functionCalling: false, toolContinuation: false, problems: ["Function calling failed: the model did not call the tool"] }),
    }));
    expect(byName(checks, "provider")).toMatchObject({ label: "Model endpoint", status: "failed" });
    expect(byName(checks, "provider").detail).toContain("supports function calling");
  });

  it("keeps a working endpoint ok when only optional parameters are unsupported", async () => {
    const checks = await runDiagnostics(input, probes({
      provider: async () => capabilities({ reasoningParameters: false, problems: ["Reasoning parameters are not supported: 400"] }),
    }));
    expect(byName(checks, "provider").status).toBe("ok");
    expect(byName(checks, "provider").detail).toContain("Notes:");
  });

  it("names the missing Google permission instead of a raw scope string", async () => {
    const checks = await runDiagnostics(input, probes({
      googleScopes: async () => ["https://www.googleapis.com/auth/calendar.events"],
    }));
    expect(byName(checks, "google")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("Gmail permission is missing"),
    });
    expect(byName(checks, "google").detail).toContain("Reconnect Google");
  });

  it("recognises a revoked Google sign-in, mentions the Testing-mode expiry, and an unconnected Google", async () => {
    const revoked = await runDiagnostics(input, probes({
      googleScopes: async () => { throw new Error("invalid_grant: Token has been expired or revoked."); },
    }));
    expect(byName(revoked, "google").detail).toContain("no longer valid");
    expect(byName(revoked, "google").detail).toContain("seven days");

    const unconnected = await runDiagnostics({ ...input, google: undefined }, probes({
      googleScopes: async () => { throw new Error("ENOENT: no such file or directory, open 'credentials.json'"); },
    }));
    expect(byName(unconnected, "google").detail).toContain("Google is not connected");
  });

  it("reports a signed-in account whose Calendar API does not answer", async () => {
    const checks = await runDiagnostics(input, probes({
      googleCalendar: async () => { throw new Error("Calendar API has not been used in project 123"); },
    }));
    expect(byName(checks, "google").detail).toContain("Calendar API is enabled");
  });

  it("skips Granola without a key and fails it with the provider's reason", async () => {
    const skipped = await runDiagnostics({ ...input, granolaApiKey: undefined }, probes());
    expect(byName(skipped, "granola").status).toBe("skipped");

    const rejected = await runDiagnostics(input, probes({
      granola: async () => { throw new Error("Granola request failed (401). Check the API key and workspace access."); },
    }));
    expect(byName(rejected, "granola")).toMatchObject({ status: "failed", detail: expect.stringContaining("401") });
  });

  it("is honest that Photon cannot be probed statically", async () => {
    const checks = await runDiagnostics(input, probes());
    expect(byName(checks, "photon")).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("replying to your text"),
    });
  });
});
