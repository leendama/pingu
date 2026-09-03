import type { AssistantConfig } from "./config.js";
import { defaultGuestSettings, type GuestSettings } from "./guests.js";
import { defaultSchedulingSettings, parseBookableDays, parseBookableHours, type SchedulingSettings } from "./scheduling-settings.js";
import { defaultTranscriptSettings, type TranscriptSettings } from "./transcripts.js";

export interface RuntimeSettings {
  assistantName: string;
  ownerName: string;
  timezone: string;
  photonProjectId: string;
  photonProjectSecret: string;
  openaiApiKey: string;
  model: string;
  /** OpenAI Responses-compatible endpoint. Empty means OpenAI itself. */
  openaiBaseUrl?: string;
  granolaApiKey?: string;
  google?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    redirectUri?: string;
  };
  /** Spectrum SDK telemetry. Off unless the owner opts in. */
  telemetry: boolean;
  guest: GuestSettings;
  transcripts: TranscriptSettings;
  scheduling: SchedulingSettings;
}

function envNumber(name: string, fallback: number, options: { min: number; max: number }): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < options.min || value > options.max) {
    throw new Error(`${name} must be a number between ${options.min} and ${options.max}.`);
  }
  return value;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

export function settingsFromConfig(config: AssistantConfig, redirectUri?: string): RuntimeSettings {
  if (!config.google.refreshToken) throw new Error("Google must be connected before the assistant can start.");
  const hours = parseBookableHours(config.bookableHours);
  return {
    assistantName: config.assistantName,
    ownerName: config.ownerName,
    timezone: config.timezone,
    photonProjectId: config.photonProjectId,
    photonProjectSecret: config.photonProjectSecret,
    openaiApiKey: config.openaiApiKey,
    model: config.model,
    openaiBaseUrl: config.openaiBaseUrl || undefined,
    granolaApiKey: config.granolaApiKey,
    google: {
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      refreshToken: config.google.refreshToken,
      redirectUri,
    },
    telemetry: config.telemetry,
    guest: { ...defaultGuestSettings, dailyMessageCap: config.guestDailyMessageCap },
    transcripts: { ...defaultTranscriptSettings, retentionDays: config.transcriptRetentionDays },
    scheduling: {
      ...defaultSchedulingSettings,
      bookableStart: hours.start,
      bookableEnd: hours.end,
      bookableDays: parseBookableDays(config.bookableDays),
      defaultDurationMinutes: config.defaultMeetingMinutes,
      meetLink: config.meetLink,
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
  const hours = parseBookableHours(process.env.PINGU_BOOKABLE_HOURS);
  const defaultDuration = envNumber("PINGU_DEFAULT_MEETING_MINUTES", defaultSchedulingSettings.defaultDurationMinutes, { min: 5, max: 480 });
  return {
    assistantName: process.env.ASSISTANT_NAME || "Pingu",
    ownerName: process.env.OWNER_NAME || "the owner",
    timezone: process.env.ASSISTANT_TIMEZONE || "UTC",
    photonProjectId: process.env.PROJECT_ID!,
    photonProjectSecret: process.env.PROJECT_SECRET!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
    granolaApiKey: process.env.GRANOLA_API_KEY,
    google,
    telemetry: envFlag("PINGU_TELEMETRY", false),
    guest: {
      dailyMessageCap: envNumber("PINGU_GUEST_DAILY_MESSAGE_CAP", defaultGuestSettings.dailyMessageCap, { min: 1, max: 500 }),
      dailyTokenBudget: envNumber("PINGU_GUEST_DAILY_TOKEN_BUDGET", defaultGuestSettings.dailyTokenBudget, { min: 1000, max: 100_000_000 }),
      maxReminders: envNumber("PINGU_GUEST_MAX_REMINDERS", defaultGuestSettings.maxReminders, { min: 0, max: 100 }),
      maxInboundChars: envNumber("PINGU_GUEST_MAX_INBOUND_CHARS", defaultGuestSettings.maxInboundChars, { min: 100, max: 50_000 }),
      maxTurnTokens: envNumber("PINGU_GUEST_MAX_TURN_TOKENS", defaultGuestSettings.maxTurnTokens, { min: 1000, max: 1_000_000 }),
      maxToolRounds: envNumber("PINGU_GUEST_MAX_TOOL_ROUNDS", defaultGuestSettings.maxToolRounds, { min: 0, max: 10 }),
    },
    transcripts: {
      ...defaultTranscriptSettings,
      retentionDays: envNumber("PINGU_TRANSCRIPT_RETENTION_DAYS", defaultTranscriptSettings.retentionDays, { min: 0, max: 3650 }),
    },
    scheduling: {
      ...defaultSchedulingSettings,
      bookableStart: hours.start,
      bookableEnd: hours.end,
      bookableDays: parseBookableDays(process.env.PINGU_BOOKABLE_DAYS),
      defaultDurationMinutes: defaultDuration,
      allowedDurations: defaultSchedulingSettings.allowedDurations.includes(defaultDuration)
        ? defaultSchedulingSettings.allowedDurations
        : [...defaultSchedulingSettings.allowedDurations, defaultDuration].sort((a, b) => a - b),
      meetLink: envFlag("PINGU_MEET_LINK", defaultSchedulingSettings.meetLink),
    },
  };
}
