import type { AssistantConfig } from "./config.js";

export interface RuntimeSettings {
  assistantName: string;
  ownerName: string;
  timezone: string;
  photonProjectId: string;
  photonProjectSecret: string;
  openaiApiKey: string;
  model: string;
  granolaApiKey?: string;
  google?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    redirectUri?: string;
  };
}

export function settingsFromConfig(config: AssistantConfig, redirectUri?: string): RuntimeSettings {
  if (!config.google.refreshToken) throw new Error("Google must be connected before the assistant can start.");
  return {
    assistantName: config.assistantName,
    ownerName: config.ownerName,
    timezone: config.timezone,
    photonProjectId: config.photonProjectId,
    photonProjectSecret: config.photonProjectSecret,
    openaiApiKey: config.openaiApiKey,
    model: config.model,
    granolaApiKey: config.granolaApiKey,
    google: {
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      refreshToken: config.google.refreshToken,
      redirectUri,
    },
  };
}

export function settingsFromEnvironment(): RuntimeSettings {
  const required = ["PROJECT_ID", "PROJECT_SECRET", "OPENAI_API_KEY"] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment values: ${missing.join(", ")}. Add them to .env.`);
  const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        redirectUri: process.env.GOOGLE_REDIRECT_URI,
      }
    : undefined;
  return {
    assistantName: process.env.ASSISTANT_NAME || "Pingu",
    ownerName: process.env.OWNER_NAME || "the owner",
    timezone: process.env.ASSISTANT_TIMEZONE || "UTC",
    photonProjectId: process.env.PROJECT_ID!,
    photonProjectSecret: process.env.PROJECT_SECRET!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    granolaApiKey: process.env.GRANOLA_API_KEY,
    google,
  };
}
