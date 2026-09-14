import { imessage } from "@spectrum-ts/imessage";
import { Spectrum } from "spectrum-ts";
import { googleClient, googleGrantedScopes, googleScopes } from "./google.js";
import { granolaPort } from "./granola.js";
import { createModelClient, describeCapabilities, probeProvider, providerKind, providerProbes, providerReady, type ProviderCapabilities } from "./provider.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import { runtimeStatus } from "./runtime-status.js";

export type CheckStatus = "ok" | "failed" | "skipped";

export interface ConnectionCheck {
  name: "provider" | "google" | "granola" | "photon";
  label: string;
  status: CheckStatus;
  /** Plain-language outcome, written for the person fixing it. */
  detail: string;
}

/** The slice of settings the checks need; the wizard can build it before Google is connected. */
export interface DiagnosticsInput {
  openaiApiKey: string;
  model: string;
  openaiBaseUrl?: string;
  granolaApiKey?: string;
  google?: RuntimeSettings["google"];
  photonProjectId?: string;
  photonProjectSecret?: string;
}

export interface DiagnosticsProbes {
  /** Run the provider capability probe: model listing, response, function call, tool continuation, reasoning parameters. */
  provider(input: Pick<DiagnosticsInput, "openaiApiKey" | "model" | "openaiBaseUrl">): Promise<ProviderCapabilities>;
  /** Refresh the Google sign-in and return the granted OAuth scopes. */
  googleScopes(google: RuntimeSettings["google"]): Promise<string[]>;
  /** Prove the Calendar API answers for the primary calendar. */
  googleCalendar(google: RuntimeSettings["google"]): Promise<void>;
  granola(apiKey: string): Promise<void>;
  /** Connect to Photon with the project credentials once, then disconnect. */
  photon(projectId: string, projectSecret: string): Promise<void>;
  /** Whether the assistant is already connected in this process, which proves the credentials without a second connection. */
  agentRunning?(): boolean;
}

const productionProbes: DiagnosticsProbes = {
  provider: (input) => {
    const settings = { apiKey: input.openaiApiKey, model: input.model, baseUrl: input.openaiBaseUrl };
    return probeProvider(providerProbes(createModelClient(settings), settings), providerKind(input.openaiBaseUrl));
  },
  googleScopes: (google) => googleGrantedScopes(google),
  googleCalendar: async (google) => {
    // Must stay callable with only the calendar.events scope Pingu requests.
    const { calendar } = await googleClient(google);
    await calendar.events.list({ calendarId: "primary", maxResults: 1 });
  },
  granola: async (apiKey) => {
    await granolaPort(apiKey).listNotes({ pageSize: 1 });
  },
  photon: async (projectId, projectSecret) => {
    const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()], telemetry: false });
    await app.stop();
  },
  agentRunning: () => Boolean(runtimeStatus().startedAt),
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkProvider(input: DiagnosticsInput, probes: DiagnosticsProbes): Promise<ConnectionCheck> {
  const kind = providerKind(input.openaiBaseUrl);
  const label = kind === "openai" ? "OpenAI" : "Model endpoint";
  let capabilities: ProviderCapabilities;
  try {
    capabilities = await probes.provider(input);
  } catch (error) {
    return { name: "provider", label, status: "failed", detail: `The model endpoint is unreachable: ${errorText(error)}` };
  }
  const summary = describeCapabilities(capabilities);
  if (providerReady(capabilities)) {
    const notes = capabilities.problems.length ? ` Notes: ${capabilities.problems.join(" ")}` : "";
    return { name: "provider", label, status: "ok", detail: `${input.model} works with function calling (${summary}).${notes}` };
  }
  const first = capabilities.problems[0] ?? "the endpoint did not complete the probe";
  const hint = /401|unauthori[sz]ed|invalid api key|incorrect api key/i.test(first)
    ? " Check the API key."
    : /404|not found|does not exist|no such model/i.test(first)
      ? ` Check that the model "${input.model}" exists on this endpoint.`
      : kind === "compatible"
        ? " Pingu needs an OpenAI Responses-compatible endpoint that supports function calling; pick a model that supports tools."
        : "";
  return { name: "provider", label, status: "failed", detail: `${first}${hint} (${summary})` };
}

async function checkGoogle(input: DiagnosticsInput, probes: DiagnosticsProbes): Promise<ConnectionCheck> {
  const label = "Google Calendar and Gmail";
  let granted: string[];
  try {
    granted = await probes.googleScopes(input.google);
  } catch (error) {
    const text = errorText(error);
    const detail = text.includes("invalid_grant")
      ? "The Google sign-in is no longer valid. Reconnect Google. If your Google Cloud app is still in Testing, its sign-ins expire after seven days; publish the app to stop that."
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

async function checkPhoton(input: DiagnosticsInput, probes: DiagnosticsProbes): Promise<ConnectionCheck> {
  const label = "Photon (iMessage)";
  if (!input.photonProjectId || !input.photonProjectSecret) {
    return { name: "photon", label, status: "skipped", detail: "Save the Photon project ID and secret first." };
  }
  if (probes.agentRunning?.()) {
    return { name: "photon", label, status: "ok", detail: "The assistant is connected to Photon. Attach an iMessage line at app.photon.codes if you have not; the final proof is Pingu replying to your text." };
  }
  try {
    await probes.photon(input.photonProjectId, input.photonProjectSecret);
    return { name: "photon", label, status: "ok", detail: "Photon accepted the project credentials. Attach an iMessage line to this project at app.photon.codes; the final proof is Pingu replying to your text." };
  } catch (error) {
    return { name: "photon", label, status: "failed", detail: `Photon rejected the connection: ${errorText(error)}. Check PROJECT_ID and PROJECT_SECRET at app.photon.codes.` };
  }
}

/**
 * Test every connection that can be probed without side effects, and say in
 * plain language what is wrong with any that fail. Whether an iMessage line is
 * attached cannot be read from here; Pingu replying to a real text is the proof.
 */
export async function runDiagnostics(input: DiagnosticsInput, probes: DiagnosticsProbes = productionProbes): Promise<ConnectionCheck[]> {
  return [
    await checkProvider(input, probes),
    await checkGoogle(input, probes),
    await checkGranola(input, probes),
    await checkPhoton(input, probes),
  ];
}
