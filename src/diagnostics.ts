import OpenAI from "openai";
import { googleClient, googleGrantedScopes, googleScopes } from "./google.js";
import { granolaPort } from "./granola.js";
import type { RuntimeSettings } from "./runtime-settings.js";

export type CheckStatus = "ok" | "failed" | "skipped";

export interface ConnectionCheck {
  name: "openai" | "google" | "granola" | "photon";
  label: string;
  status: CheckStatus;
  /** Plain-language outcome, written for the person fixing it. */
  detail: string;
}

/** The slice of settings the checks need; the wizard can build it before Google is connected. */
export interface DiagnosticsInput {
  openaiApiKey: string;
  model: string;
  granolaApiKey?: string;
  google?: RuntimeSettings["google"];
}

export interface DiagnosticsProbes {
  /** Resolve when the key can use the model; throw the provider's failure otherwise. */
  openai(apiKey: string, model: string): Promise<void>;
  /** Refresh the Google sign-in and return the granted OAuth scopes. */
  googleScopes(google: RuntimeSettings["google"]): Promise<string[]>;
  /** Prove the Calendar API answers for the primary calendar. */
  googleCalendar(google: RuntimeSettings["google"]): Promise<void>;
  granola(apiKey: string): Promise<void>;
}

const productionProbes: DiagnosticsProbes = {
  openai: async (apiKey, model) => {
    await new OpenAI({ apiKey }).models.retrieve(model);
  },
  googleScopes: (google) => googleGrantedScopes(google),
  googleCalendar: async (google) => {
    const { calendar } = await googleClient(google);
    await calendar.calendars.get({ calendarId: "primary" });
  },
  granola: async (apiKey) => {
    await granolaPort(apiKey).listNotes({ pageSize: 1 });
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

async function checkOpenAi(input: DiagnosticsInput, probes: DiagnosticsProbes): Promise<ConnectionCheck> {
  const label = "OpenAI";
  try {
    await probes.openai(input.openaiApiKey, input.model);
    return { name: "openai", label, status: "ok", detail: `The key can use ${input.model}.` };
  } catch (error) {
    const status = errorStatus(error);
    const detail = status === 401
      ? "OpenAI rejected the API key. Check the key and try again."
      : status === 404
        ? `The key works, but the model "${input.model}" is not available to it. Pick another model.`
        : `OpenAI is unreachable: ${errorText(error)}`;
    return { name: "openai", label, status: "failed", detail };
  }
}

async function checkGoogle(input: DiagnosticsInput, probes: DiagnosticsProbes): Promise<ConnectionCheck> {
  const label = "Google Calendar and Gmail";
  let granted: string[];
  try {
    granted = await probes.googleScopes(input.google);
  } catch (error) {
    const text = errorText(error);
    const detail = text.includes("invalid_grant")
      ? "The Google sign-in is no longer valid. Reconnect Google."
      : /ENOENT|no such file/i.test(text)
        ? "Google is not connected. Run `npm run connect:google`, or connect it in the setup wizard."
        : `Google sign-in failed: ${text}`;
    return { name: "google", label, status: "failed", detail };
  }
  const missing = googleScopes.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    const gmailMissing = missing.some((scope) => scope.includes("gmail"));
    const calendarMissing = missing.some((scope) => scope.includes("calendar"));
    const parts = [
      ...(gmailMissing ? ["Gmail permission is missing"] : []),
      ...(calendarMissing ? ["Calendar permission is missing"] : []),
    ];
    return { name: "google", label, status: "failed", detail: `${parts.join(" and ")}. Reconnect Google and approve every permission.` };
  }
  try {
    await probes.googleCalendar(input.google);
  } catch (error) {
    return { name: "google", label, status: "failed", detail: `Signed in, but Google Calendar is unreachable: ${errorText(error)}. Check that the Calendar API is enabled for your Google Cloud project.` };
  }
  return { name: "google", label, status: "ok", detail: "Signed in with calendar and Gmail permissions." };
}

async function checkGranola(input: DiagnosticsInput, probes: DiagnosticsProbes): Promise<ConnectionCheck> {
  const label = "Granola";
  if (!input.granolaApiKey) {
    return { name: "granola", label, status: "skipped", detail: "No API key configured. Granola tools stay disabled — that's fine." };
  }
  try {
    await probes.granola(input.granolaApiKey);
    return { name: "granola", label, status: "ok", detail: "The API key can read meeting notes." };
  } catch (error) {
    return { name: "granola", label, status: "failed", detail: `Granola rejected the request: ${errorText(error)}` };
  }
}

/**
 * Test every connection that can be probed without side effects, and say in
 * plain language what is wrong with any that fail. Photon credentials cannot
 * be probed statically — they are verified when the assistant starts, and
 * proven end to end by Pingu replying to a real text.
 */
export async function runDiagnostics(input: DiagnosticsInput, probes: DiagnosticsProbes = productionProbes): Promise<ConnectionCheck[]> {
  return [
    await checkOpenAi(input, probes),
    await checkGoogle(input, probes),
    await checkGranola(input, probes),
    {
      name: "photon",
      label: "Photon (iMessage)",
      status: "skipped",
      detail: "Verified when the assistant starts — a startup failure reports its reason. The final proof is Pingu replying to your text.",
    },
  ];
}
