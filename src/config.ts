import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseBookableDays, parseBookableHours } from "./scheduling-settings.js";
import { atomicWriteText, dataPath, withFileLock } from "./state.js";

const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid IANA timezone, such as UTC.");

const optionalUrl = z.string().trim().optional().refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "Enter a full http(s) URL for the model endpoint, or leave it blank for OpenAI.");

const bookableHours = z.string().trim().default("09:00-17:00").refine((value) => {
  try {
    parseBookableHours(value);
    return true;
  } catch {
    return false;
  }
}, "Bookable hours must look like 09:00-17:00 or 24h.");

const bookableDays = z.string().trim().default("weekdays").refine((value) => {
  try {
    parseBookableDays(value);
    return true;
  } catch {
    return false;
  }
}, "Bookable days must be weekdays, all, or day numbers 0-6.");

export const assistantConfigSchema = z.object({
  assistantName: z.string().trim().min(1).max(40).default("Pingu"),
  ownerName: z.string().trim().min(1).max(80),
  timezone,
  photonProjectId: z.string().trim().min(1),
  photonProjectSecret: z.string().trim().min(1),
  /** Any non-empty value; local endpoints often ignore it. */
  openaiApiKey: z.string().trim().min(1),
  model: z.string().trim().min(1).default("gpt-5.6-luna"),
  openaiBaseUrl: optionalUrl,
  granolaApiKey: z.string().trim().optional(),
  /** Own Google OAuth client. Both blank means Pingu's shared registration, when one ships. */
  google: z.object({
    clientId: z.string().trim().optional(),
    clientSecret: z.string().trim().optional(),
    refreshToken: z.string().optional(),
  }).refine((google) => Boolean(google.clientId) === Boolean(google.clientSecret), "Enter both the Google client ID and secret, or leave both blank to use Pingu's shared Google app."),
  telemetry: z.boolean().default(false),
  guestDailyMessageCap: z.coerce.number().int().min(1).max(500).default(20),
  transcriptRetentionDays: z.coerce.number().int().min(0).max(3650).default(30),
  bookableHours,
  bookableDays,
  defaultMeetingMinutes: z.coerce.number().int().min(5).max(480).default(30),
  meetLink: z.boolean().default(true),
});

export type AssistantConfig = z.infer<typeof assistantConfigSchema>;

interface EncryptedDocument {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function encryptionKey(): Buffer {
  const secret = process.env.PHOTON_CONFIG_KEY;
  if (!secret || secret.length < 24) {
    throw new Error("PHOTON_CONFIG_KEY must be a random value of at least 24 characters.");
  }
  return createHash("sha256").update(secret).digest();
}

const configPath = () => dataPath("config.enc.json");

export async function loadConfig(): Promise<AssistantConfig | undefined> {
  const path = configPath();
  return withFileLock(path, async () => {
    try {
      const document = JSON.parse(await readFile(path, "utf8")) as EncryptedDocument;
      if (document.version !== 1) throw new Error("Unsupported encrypted configuration version.");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(document.iv, "base64"));
      decipher.setAuthTag(Buffer.from(document.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(document.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return assistantConfigSchema.parse(JSON.parse(plaintext));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
}

export async function saveConfig(input: unknown): Promise<AssistantConfig> {
  const target = configPath();
  return withFileLock(target, async () => {
    const config = assistantConfigSchema.parse(input);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
    const document: EncryptedDocument = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await atomicWriteText(target, `${JSON.stringify(document, null, 2)}\n`);
    return config;
  });
}

export function publicUrl(): string {
  return (process.env.PHOTON_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
}
