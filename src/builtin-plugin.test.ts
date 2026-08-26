import { describe, expect, it } from "vitest";
import { builtInPlugins } from "./builtin-plugin.js";
import { PluginRegistry, type ToolRunContext } from "./plugins.js";

function context(isGroup: boolean): ToolRunContext {
  return { isGroup, config: { timezone: "UTC" }, sideEffectAttempted: false } as ToolRunContext;
}

describe("built-in plugin policy", () => {
  const plugins = builtInPlugins();
  const registry = new PluginRegistry(plugins);

  it("registers every built-in tool through the safe registry", () => {
    expect(registry.tools).toHaveLength(plugins.flatMap((plugin) => plugin.tools).length);
    expect(registry.tools.length).toBeGreaterThan(20);
  });

  it("blocks private built-ins in group chats", async () => {
    const result = await registry.run("search_calendar", "{}", context(true));
    expect(result.handled && JSON.parse(result.output).error).toMatch(/private/);
  });

  it("marks write tools as side-effecting before dispatch", async () => {
    const turn = context(false);
    await registry.run("create_calendar_event", "{}", turn);
    expect(turn.sideEffectAttempted).toBe(true);
  });

  it("keeps declared read tools replayable", async () => {
    const turn = context(false);
    await registry.run("get_current_time", JSON.stringify({ timezone: "UTC" }), turn);
    expect(turn.sideEffectAttempted).toBe(false);
  });
});
