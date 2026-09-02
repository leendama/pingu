import { describe, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import { describeCapabilities, probeProvider, providerKind, providerReady, type ProviderProbes } from "./provider.js";

function text(value: string): Response {
  return { output: [], output_text: value, status: "completed" } as unknown as Response;
}

function call(): Response {
  return { output: [{ type: "function_call", name: "probe_echo", call_id: "c1", arguments: "{\"value\":\"ping\"}" }], output_text: "", status: "completed" } as unknown as Response;
}

function probes(overrides: Partial<ProviderProbes> = {}): ProviderProbes {
  return {
    listModels: async () => undefined,
    respond: vi.fn(async (input: unknown, options: { tools?: unknown[]; reasoning?: boolean }) => {
      if (options.tools && typeof input === "string") return call();
      return text("OK");
    }),
    ...overrides,
  };
}

describe("providerKind", () => {
  it("treats an empty or OpenAI base URL as OpenAI and anything else as compatible", () => {
    expect(providerKind(undefined)).toBe("openai");
    expect(providerKind("")).toBe("openai");
    expect(providerKind("https://api.openai.com/v1")).toBe("openai");
    expect(providerKind("http://localhost:11434/v1")).toBe("compatible");
    expect(providerKind("not a url")).toBe("compatible");
  });
});

describe("probeProvider", () => {
  it("proves every capability with the smallest requests and derives voice from the provider kind", async () => {
    const result = await probeProvider(probes(), "openai");
    expect(result).toMatchObject({ modelListing: true, response: true, functionCalling: true, toolContinuation: true, reasoningParameters: true, voice: true, problems: [] });
    expect(providerReady(result)).toBe(true);
    expect(await probeProvider(probes(), "compatible")).toMatchObject({ voice: false });
  });

  it("stops after a failed basic response and reports the reason", async () => {
    const result = await probeProvider(probes({
      respond: async () => { throw Object.assign(new Error("401 Unauthorized"), { status: 401 }); },
    }), "openai");
    expect(result.response).toBe(false);
    expect(result.problems).toEqual(["Basic response failed: 401 Unauthorized"]);
    expect(providerReady(result)).toBe(false);
  });

  it("marks an endpoint unusable when the model will not call tools", async () => {
    const result = await probeProvider(probes({ respond: async () => text("I cannot call tools") }), "compatible");
    expect(result).toMatchObject({ response: true, functionCalling: false, toolContinuation: false });
    expect(result.problems[0]).toContain("did not call the tool");
    expect(providerReady(result)).toBe(false);
  });

  it("keeps an endpoint usable when only reasoning parameters are rejected", async () => {
    const result = await probeProvider(probes({
      respond: async (input, options) => {
        if (options.reasoning) throw new Error("400 unknown parameter: reasoning");
        return options.tools && typeof input === "string" ? call() : text("OK");
      },
    }), "compatible");
    expect(result.reasoningParameters).toBe(false);
    expect(providerReady(result)).toBe(true);
    expect(describeCapabilities(result)).toContain("reasoning parameters: no");
  });
});
