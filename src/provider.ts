import OpenAI from "openai";
import type { Response, ResponseInput, Tool } from "openai/resources/responses/responses";

export type ProviderKind = "openai" | "compatible";

export interface ProviderSettings {
  apiKey: string;
  model: string;
  /** An OpenAI Responses-compatible endpoint such as Ollama or LM Studio. Empty means OpenAI itself. */
  baseUrl?: string;
}

/** What the configured endpoint proved it can do. Tools and request parameters are registered from this, never assumed. */
export interface ProviderCapabilities {
  kind: ProviderKind;
  modelListing: boolean;
  response: boolean;
  functionCalling: boolean;
  toolContinuation: boolean;
  reasoningParameters: boolean;
  voice: boolean;
  /** Plain-language failures, one per probe that did not pass. */
  problems: string[];
}

export function providerKind(baseUrl?: string): ProviderKind {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return "openai";
  try {
    return new URL(trimmed).hostname === "api.openai.com" ? "openai" : "compatible";
  } catch {
    return "compatible";
  }
}

export function createModelClient(settings: ProviderSettings): OpenAI {
  const baseURL = settings.baseUrl?.trim() || undefined;
  return new OpenAI({ apiKey: settings.apiKey || "not-needed", baseURL });
}

const PROBE_TOOL: Tool = {
  type: "function",
  name: "probe_echo",
  description: "Echo a value back. Used only to test that the model can call tools.",
  strict: true,
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export interface ProviderProbes {
  listModels(): Promise<void>;
  respond(input: ResponseInput | string, options: { tools?: Tool[]; reasoning?: boolean }): Promise<Response>;
}

export function providerProbes(client: OpenAI, settings: ProviderSettings): ProviderProbes {
  const kind = providerKind(settings.baseUrl);
  return {
    listModels: async () => {
      await client.models.list();
    },
    respond: (input, options) => client.responses.create({
      model: settings.model,
      input,
      instructions: "You are a connectivity probe. Follow the instruction exactly and reply with as few words as possible.",
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.reasoning ? { reasoning: { effort: "low" }, text: { verbosity: "low" } } : {}),
      ...(kind === "openai" ? { store: false } : {}),
    }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prove what the endpoint supports with the smallest possible requests: model
 * listing, a plain response, a function call, continuing after a tool result,
 * and the reasoning parameters. Voice is an OpenAI-only feature by decision, so
 * it is derived from the provider kind rather than probed with an audio request.
 */
export async function probeProvider(probes: ProviderProbes, kind: ProviderKind): Promise<ProviderCapabilities> {
  const capabilities: ProviderCapabilities = {
    kind,
    modelListing: false,
    response: false,
    functionCalling: false,
    toolContinuation: false,
    reasoningParameters: false,
    voice: kind === "openai",
    problems: [],
  };

  try {
    await probes.listModels();
    capabilities.modelListing = true;
  } catch (error) {
    capabilities.problems.push(`Model listing failed: ${errorText(error)}`);
  }

  try {
    const response = await probes.respond("Reply with the single word OK.", {});
    if (!response.output_text?.trim()) throw new Error("the model returned no text");
    capabilities.response = true;
  } catch (error) {
    capabilities.problems.push(`Basic response failed: ${errorText(error)}`);
    return capabilities;
  }

  try {
    const response = await probes.respond("Call the probe_echo tool with the value \"ping\". Do not answer in text.", { tools: [PROBE_TOOL] });
    const call = response.output.find((item) => item.type === "function_call");
    if (!call || call.name !== "probe_echo") throw new Error("the model did not call the tool");
    capabilities.functionCalling = true;
    const continuation = await probes.respond([
      { type: "message", role: "user", content: "Call the probe_echo tool with the value \"ping\", then tell me what it returned." },
      { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value: "pong" }) },
    ], { tools: [PROBE_TOOL] });
    if (!continuation.output_text?.trim()) throw new Error("the model returned no text after the tool result");
    capabilities.toolContinuation = true;
  } catch (error) {
    capabilities.problems.push(`Function calling failed: ${errorText(error)}`);
  }

  try {
    const response = await probes.respond("Reply with the single word OK.", { reasoning: true });
    if (!response.output_text?.trim()) throw new Error("the model returned no text");
    capabilities.reasoningParameters = true;
  } catch (error) {
    capabilities.problems.push(`Reasoning parameters are not supported: ${errorText(error)}`);
  }

  return capabilities;
}

/** The capabilities Pingu needs before it will start. */
export function providerReady(capabilities: ProviderCapabilities): boolean {
  return capabilities.response && capabilities.functionCalling && capabilities.toolContinuation;
}

export function describeCapabilities(capabilities: ProviderCapabilities): string {
  const yes = (value: boolean) => value ? "yes" : "no";
  return [
    `provider: ${capabilities.kind}`,
    `models listed: ${yes(capabilities.modelListing)}`,
    `response: ${yes(capabilities.response)}`,
    `function calling: ${yes(capabilities.functionCalling)}`,
    `tool continuation: ${yes(capabilities.toolContinuation)}`,
    `reasoning parameters: ${yes(capabilities.reasoningParameters)}`,
    `voice: ${yes(capabilities.voice)}`,
  ].join(", ");
}
