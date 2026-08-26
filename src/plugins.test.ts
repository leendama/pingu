import type { Tool } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import { PluginRegistry, type AssistantPlugin, type ToolRunContext } from "./plugins.js";

const schema: Tool = {
  type: "function",
  name: "example",
  description: "Example tool",
  strict: true,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

function context(isGroup: boolean): ToolRunContext {
  return { isGroup, config: { timezone: "UTC" }, sideEffectAttempted: false } as ToolRunContext;
}

describe("PluginRegistry", () => {
  const plugin: AssistantPlugin = { id: "example", name: "Example", tools: [schema], run: async () => ({ output: "ok" }) };

  it("keeps plugin tools private and side-effecting by default", async () => {
    const registry = new PluginRegistry([plugin]);
    const privateResult = await registry.run("example", "{}", context(true));
    expect(privateResult.handled && JSON.parse(privateResult.output).error).toMatch(/private/);
    const direct = context(false);
    expect(await registry.run("example", "{}", direct)).toEqual({ handled: true, output: "ok" });
    expect(direct.sideEffectAttempted).toBe(true);
  });
});
