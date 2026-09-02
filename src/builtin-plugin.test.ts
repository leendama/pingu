import { describe, expect, it } from "vitest";
import { builtInPlugins } from "./builtin-plugin.js";
import { PluginRegistry, type ToolRunContext } from "./plugins.js";

function context(isGroup: boolean, role: "owner" | "guest" = "owner"): ToolRunContext {
  return { isGroup, role, spaceId: "chat", config: { timezone: "UTC" }, sideEffectAttempted: false, untrustedContentSeen: false } as ToolRunContext;
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

  it("offers guests only chat, reminders, message features, and nothing private", () => {
    const names = registry.toolsFor(context(false, "guest")).map((tool) => tool.type === "function" ? tool.name : "");
    expect(names).toContain("create_reminder");
    expect(names).toContain("react_to_message");
    expect(names).toContain("forget_this_conversation");
    expect(names).not.toContain("search_gmail");
    expect(names).not.toContain("search_calendar");
    expect(names).not.toContain("list_granola_notes");
    expect(names).not.toContain("get_group_members");
  });

  it("drops the voice tool when the provider cannot synthesise speech", () => {
    const silent = new PluginRegistry(builtInPlugins(undefined, { voice: false }));
    expect(silent.tools.some((tool) => tool.type === "function" && tool.name === "send_voice_reply")).toBe(false);
    expect(registry.tools.some((tool) => tool.type === "function" && tool.name === "send_voice_reply")).toBe(true);
  });

  it("marks Gmail and Granola reads as third-party content", async () => {
    const turn = context(false);
    await registry.run("read_gmail_message", JSON.stringify({ message_id: "m1" }), turn);
    expect(turn.untrustedContentSeen).toBe(true);
  });
});
