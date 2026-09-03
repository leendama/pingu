import { afterEach, describe, expect, it } from "vitest";
import { resolveGoogleClient } from "./runtime-settings.js";
import { isLoopbackUrl, sharedGoogleClient, usesSharedGoogleClient } from "./shared-google-client.js";

afterEach(() => {
  delete process.env.PINGU_SHARED_GOOGLE_CLIENT_ID;
  delete process.env.PINGU_SHARED_GOOGLE_CLIENT_SECRET;
});

describe("shared Google client", () => {
  it("is absent until a registration is filled in, and then used only when the person has none of their own", () => {
    expect(sharedGoogleClient()).toBeUndefined();
    expect(() => resolveGoogleClient({})).toThrow(/No Google client is configured/);
    process.env.PINGU_SHARED_GOOGLE_CLIENT_ID = "shared.apps.googleusercontent.com";
    process.env.PINGU_SHARED_GOOGLE_CLIENT_SECRET = "secret";
    expect(sharedGoogleClient()).toEqual({ clientId: "shared.apps.googleusercontent.com", clientSecret: "secret" });
    expect(usesSharedGoogleClient({})).toBe(true);
    expect(usesSharedGoogleClient({ clientId: "own", clientSecret: "own-secret" })).toBe(false);
    expect(resolveGoogleClient({ clientId: "own", clientSecret: "own-secret" })).toEqual({ clientId: "own", clientSecret: "own-secret" });
    expect(resolveGoogleClient({})).toEqual({ clientId: "shared.apps.googleusercontent.com", clientSecret: "secret" });
  });

  it("recognises loopback addresses, the only ones an installed-app client may redirect to", () => {
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:3000/setup")).toBe(true);
    expect(isLoopbackUrl("https://pingu.example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
