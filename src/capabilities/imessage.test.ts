import { describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "../plugins.js";
import { imessagePlugin } from "./imessage.js";

function fakeContext(overrides: Partial<Record<string, unknown>> = {}): ToolRunContext {
  return {
    isGroup: false,
    spaceId: "space-1",
    message: { react: vi.fn(async () => undefined) },
    space: {
      send: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      getMembers: vi.fn(async () => ["+15550101000"]),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    sendVoice: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ToolRunContext;
}

describe("imessagePlugin", () => {
  it("reacting reports the response as already delivered", async () => {
    const context = fakeContext();
    const result = await imessagePlugin().run("react_to_message", JSON.stringify({ reaction: "love" }), context);
    expect(result.delivered).toBe(true);
    expect(context.message.react).toHaveBeenCalledWith("love");
  });

  it("voice replies go through the injected sendVoice and count as delivered", async () => {
    const context = fakeContext();
    const result = await imessagePlugin().run("send_voice_reply", JSON.stringify({ text: "hello" }), context);
    expect(result.delivered).toBe(true);
    expect(context.sendVoice).toHaveBeenCalledWith("hello");
  });

  it("group management tools are rejected outside a group chat", async () => {
    const context = fakeContext();
    const result = await imessagePlugin().run("rename_group", JSON.stringify({ name: "The crew" }), context);
    expect(JSON.parse(result.output).error).toMatch(/group chat/);
    expect((context.space as unknown as { rename: ReturnType<typeof vi.fn> }).rename).not.toHaveBeenCalled();
  });

  it("group management tools work inside a group chat and are not marked delivered", async () => {
    const context = fakeContext({ isGroup: true });
    const result = await imessagePlugin().run("rename_group", JSON.stringify({ name: "The crew" }), context);
    expect(result.delivered).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ renamed: true, name: "The crew" });
  });

  it("declares every tool group-safe and only reads as side-effect free", () => {
    const plugin = imessagePlugin();
    expect(plugin.privateTools).toEqual([]);
    expect(plugin.sideEffectingTools).not.toContain("get_group_members");
    expect(plugin.sideEffectingTools).toContain("send_poll");
  });
});
