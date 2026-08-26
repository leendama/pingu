import { resolve } from "node:path";
import { dataPath } from "./state.js";

export function googleCredentialsPath(): string {
  return resolve(process.env.GOOGLE_CREDENTIALS_PATH || "credentials.json");
}

export function googleTokenPath(): string {
  return dataPath("google-token.json");
}
