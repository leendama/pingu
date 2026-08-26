import { describe, expect, it } from "vitest";
import { capabilityPlugin, type ToolDeclaration, type ToolRunContext } from "./tools.js";

function declaration(overrides: Partial<ToolDeclaration> & { name?: string } = {}): ToolDeclaration {
  const { name = "demo_tool", ...rest } = overrides;
  return {
    schema: {
      type: "function",
      name,
      description: "Test tool",
      strict: true,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    run: async () => ({ output: JSON.stringify({ ok: true }) }),
    ...rest,
  };
}

const directChat = { isGroup: false } as ToolRunContext;
const groupChat = { isGroup: true } as ToolRunContext;

describe("capabilityPlugin", () => {
  it("derives schemas, side-effect names, and private names from the declarations", () => {
    const plugin = capabilityPlugin({ id: "demo", name: "Demo", description: "test" }, [
      declaration({ name: "pure_read", sideEffecting: false, private: false }),
      declaration({ name: "private_write" }),
    ]);
    expect(plugin.tools.map((tool) => tool.type === "function" && tool.name)).toEqual(["pure_read", "private_write"]);
    expect(plugin.sideEffectingTools).toEqual(["private_write"]);
    expect(plugin.privateTools).toEqual(["private_write"]);
  });

  it("treats undeclared privacy and mutability as private and side effecting", () => {
    const plugin = capabilityPlugin({ id: "demo", name: "Demo", description: "test" }, [declaration()]);
    expect(plugin.sideEffectingTools).toEqual(["demo_tool"]);
    expect(plugin.privateTools).toEqual(["demo_tool"]);
  });

  it("dispatches by tool name and parses arguments", async () => {
    const plugin = capabilityPlugin({ id: "demo", name: "Demo", description: "test" }, [
      declaration({
        name: "echo",
        run: async (args) => ({ output: JSON.stringify({ echoed: args.value }) }),
      }),
    ]);
    await expect(plugin.run("echo", JSON.stringify({ value: 7 }), directChat)).resolves.toEqual({
      output: JSON.stringify({ echoed: 7 }),
    });
  });

  it("returns an error payload for unknown tools", async () => {
    const plugin = capabilityPlugin({ id: "demo", name: "Demo", description: "test" }, [declaration()]);
    const result = await plugin.run("missing", "{}", directChat);
    expect(JSON.parse(result.output)).toEqual({ error: "Unknown tool: missing" });
  });

  it("converts thrown errors into an error payload for the model", async () => {
    const plugin = capabilityPlugin({ id: "demo", name: "Demo", description: "test" }, [
      declaration({ run: async () => { throw new Error("Gmail exploded."); } }),
    ]);
    const result = await plugin.run("demo_tool", "{}", directChat);
    expect(JSON.parse(result.output)).toEqual({ error: "Gmail exploded." });
  });

  it("rejects group-only tools outside a group chat", async () => {
    const plugin = capabilityPlugin({ id: "demo", name: "Demo", description: "test" }, [
      declaration({ groupOnly: true }),
    ]);
    const blocked = await plugin.run("demo_tool", "{}", directChat);
    expect(JSON.parse(blocked.output).error).toMatch(/group chat/);
    const allowed = await plugin.run("demo_tool", "{}", groupChat);
    expect(JSON.parse(allowed.output)).toEqual({ ok: true });
  });
});
