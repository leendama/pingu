import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { googleCredentialsPath, googleTokenPath } from "./private-paths.js";

afterEach(() => {
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.PHOTON_DATA_DIR;
});

describe("private runtime paths", () => {
  it("uses external credentials and data directories when configured", () => {
    process.env.GOOGLE_CREDENTIALS_PATH = "/private/pingu/credentials.json";
    process.env.PHOTON_DATA_DIR = "/private/pingu/data";

    expect(googleCredentialsPath()).toBe("/private/pingu/credentials.json");
    expect(googleTokenPath()).toBe("/private/pingu/data/google-token.json");
  });

  it("keeps backwards-compatible local defaults", () => {
    expect(googleCredentialsPath()).toBe(resolve("credentials.json"));
    expect(googleTokenPath()).toBe(resolve("data/google-token.json"));
  });
});
