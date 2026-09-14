import { existsSync } from "node:fs";
import { googleCredentialsPath } from "./private-paths.js";

/**
 * Pingu's own Google OAuth registration, so people never open the Google Cloud
 * console. Google treats "installed application" clients as public, which is
 * why the secret can ship in source; the refresh tokens it mints stay on the
 * owner's disk. Fill these in from the registration, or set the environment
 * values, before cutting a release. Empty means "bring your own project".
 *
 * Google shows an "unverified app" screen until the registration is verified
 * and allows about a hundred users before then; that is the accepted launch
 * trade-off. A person can always use their own client instead.
 */
export const SHARED_GOOGLE_CLIENT = {
  clientId: "",
  clientSecret: "",
};

export interface GoogleClientCredentials {
  clientId: string;
  clientSecret: string;
}

export function sharedGoogleClient(): GoogleClientCredentials | undefined {
  const clientId = process.env.PINGU_SHARED_GOOGLE_CLIENT_ID?.trim() || SHARED_GOOGLE_CLIENT.clientId;
  const clientSecret = process.env.PINGU_SHARED_GOOGLE_CLIENT_SECRET?.trim() || SHARED_GOOGLE_CLIENT.clientSecret;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** True when the person supplied nothing of their own and Pingu's registration is available. */
export function usesSharedGoogleClient(own?: Partial<GoogleClientCredentials>): boolean {
  return !(own?.clientId && own?.clientSecret) && sharedGoogleClient() !== undefined;
}

/** An installed-app client may redirect to any loopback address without registering it. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  } catch {
    return false;
  }
}

/** A credentials.json-shaped document for the shared client, for code paths that read one from disk. */
export function sharedClientKeyfile(): string | undefined {
  const shared = sharedGoogleClient();
  if (!shared) return undefined;
  return JSON.stringify({ installed: { client_id: shared.clientId, client_secret: shared.clientSecret, redirect_uris: ["http://localhost"] } }, null, 2);
}

/** The person's own credentials.json when present, otherwise nothing; callers then fall back to the shared client. */
export function ownCredentialsFileExists(): boolean {
  return existsSync(googleCredentialsPath());
}
