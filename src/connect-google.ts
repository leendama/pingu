import "./env.js";

import { authenticate } from "@google-cloud/local-auth";
import { googleCredentialsPath, googleTokenPath } from "./private-paths.js";
import { ownCredentialsFileExists, sharedClientKeyfile } from "./shared-google-client.js";
import { atomicWriteText, dataPath } from "./state.js";

const scopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

let keyfilePath = googleCredentialsPath();
if (!ownCredentialsFileExists()) {
  const shared = sharedClientKeyfile();
  if (!shared) {
    console.error(`No ${keyfilePath} found and this build ships no shared Google app. Create an OAuth desktop client in Google Cloud and save it as credentials.json (see docs/SETUP.md).`);
    process.exit(1);
  }
  keyfilePath = dataPath("shared-google-client.json");
  await atomicWriteText(keyfilePath, `${shared}\n`);
  console.log("Using Pingu's shared Google app. Google may show an \"unverified app\" screen once; choose Continue.");
}

const auth = await authenticate({
  scopes,
  keyfilePath,
});

await atomicWriteText(googleTokenPath(), `${JSON.stringify(auth.credentials, null, 2)}\n`);

console.log("Google connected. Token saved locally for Photon Spectrum.");
