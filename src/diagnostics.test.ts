import { describe, expect, it } from "vitest";
import { runDiagnostics, type DiagnosticsProbes } from "./diagnostics.js";

const google = { clientId: "client-1", clientSecret: "secret", refreshToken: "token" };

const allScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

function probes(overrides: Partial<DiagnosticsProbes> = {}): DiagnosticsProbes {
  return {
    openai: async () => undefined,
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
    expect(byName(checks, "openai").status).toBe("ok");
    expect(byName(checks, "google").status).toBe("ok");
    expect(byName(checks, "granola").status).toBe("ok");
  });

  it("says an OpenAI key was rejected on a 401 and names an unavailable model on a 404", async () => {
    const unauthorized = await runDiagnostics(input, probes({
      openai: async () => { throw Object.assign(new Error("Unauthorized"), { status: 401 }); },
    }));
    expect(byName(unauthorized, "openai")).toMatchObject({ status: "failed", detail: expect.stringContaining("rejected the API key") });

    const missingModel = await runDiagnostics(input, probes({
      openai: async () => { throw Object.assign(new Error("Not found"), { status: 404 }); },
    }));
    expect(byName(missingModel, "openai").detail).toContain('the model "gpt-5.6-luna" is not available');
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

  it("recognises a revoked Google sign-in and an unconnected Google", async () => {
    const revoked = await runDiagnostics(input, probes({
      googleScopes: async () => { throw new Error("invalid_grant: Token has been expired or revoked."); },
    }));
    expect(byName(revoked, "google").detail).toContain("no longer valid");

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
