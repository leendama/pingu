import { describe, expect, it } from "vitest";
import { googleClient } from "./google.js";

describe("Google adapter", () => {
  it("reuses one authenticated client for the same credentials", async () => {
    const credentials = {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      redirectUri: "http://localhost/callback",
    };
    expect(await googleClient(credentials)).toBe(await googleClient(credentials));
  });
});
