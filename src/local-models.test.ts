import { describe, expect, it, vi } from "vitest";
import { detectLocalModelEndpoint, preferredLocalModel } from "./local-models.js";

describe("local model detection", () => {
  it("finds the first server that answers and lists its models", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("http://localhost:11434")) throw new Error("ECONNREFUSED");
      if (url.startsWith("http://localhost:1234")) return { ok: true, json: async () => ({ data: [{ id: "qwen2.5-7b-instruct" }, { id: 42 }] }) };
      throw new Error("unreachable");
    });
    expect(await detectLocalModelEndpoint(fetchImpl as never)).toEqual({ name: "LM Studio", baseUrl: "http://localhost:1234/v1", models: ["qwen2.5-7b-instruct"] });
  });

  it("returns nothing when no server answers, quickly", async () => {
    const started = Date.now();
    const hanging = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    expect(await detectLocalModelEndpoint(hanging as never, 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("prefers a tool-capable model name", () => {
    expect(preferredLocalModel(["nomic-embed-text", "qwen3:8b", "llama3.2"])).toBe("qwen3:8b");
    expect(preferredLocalModel(["mystery"])).toBe("mystery");
    expect(preferredLocalModel([])).toBeUndefined();
  });
});
