import "./env.js";

import { authenticate } from "@google-cloud/local-auth";
import { googleCredentialsPath, googleTokenPath } from "./private-paths.js";
import { atomicWriteText } from "./state.js";

const scopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const auth = await authenticate({
  scopes,
  keyfilePath: googleCredentialsPath(),
});

await atomicWriteText(googleTokenPath(), `${JSON.stringify(auth.credentials, null, 2)}\n`);

console.log("Google connected. Token saved locally for Photon Spectrum.");
