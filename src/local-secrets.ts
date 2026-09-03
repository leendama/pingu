import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { publicUrl } from "./config.js";
import { isLoopbackUrl } from "./shared-google-client.js";
import { atomicWriteText, dataPath } from "./state.js";

const CONFIG_KEY_FILE = "config-key";

/**
 * On a localhost install nobody should have to invent secrets. The config key
 * is generated once and kept in the data directory, because the encrypted
 * settings are useless without it. The setup token is generated per start and
 * only ever shown in the one-time link, so it never needs to be remembered.
 * Public hosts keep explicit secrets: a generated token printed to a log is
 * no protection for a wizard reachable from the internet.
 */
export async function ensureLocalSecrets(env: NodeJS.ProcessEnv = process.env): Promise<{ generatedToken: boolean; generatedKey: boolean }> {
  const loopback = !env.PHOTON_PUBLIC_URL || isLoopbackUrl(env.PHOTON_PUBLIC_URL);
  if (!loopback) return { generatedToken: false, generatedKey: false };
  let generatedKey = false;
  if (!env.PHOTON_CONFIG_KEY || env.PHOTON_CONFIG_KEY.length < 24) {
    const path = dataPath(CONFIG_KEY_FILE);
    let key: string | undefined;
    try {
      key = (await readFile(path, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!key) {
      key = randomBytes(32).toString("base64url");
      await atomicWriteText(path, `${key}\n`);
      generatedKey = true;
    }
    env.PHOTON_CONFIG_KEY = key;
  }
  let generatedToken = false;
  if (!env.PHOTON_SETUP_TOKEN || env.PHOTON_SETUP_TOKEN.length < 20) {
    env.PHOTON_SETUP_TOKEN = randomBytes(24).toString("base64url");
    generatedToken = true;
  }
  return { generatedToken, generatedKey };
}

/** The one link a new person opens: it carries the setup token and lands them on the wizard, signed in. */
export function setupLink(env: NodeJS.ProcessEnv = process.env): string {
  return `${publicUrl()}/setup/enter?token=${encodeURIComponent(env.PHOTON_SETUP_TOKEN ?? "")}`;
}
