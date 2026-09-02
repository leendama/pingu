import { describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "../plugins.js";
import { privacyPlugin } from "./privacy.js";

describe("privacyPlugin", () => {
  it("forgets only the current chat and is available to guests", async () => {
    const forget = vi.fn(async (_spaceId: string) => undefined);
    const plugin = privacyPlugin({ forget });
    const result = await plugin.run("forget_this_conversation", "{}", { spaceId: "guest-dm", role: "guest", isGroup: false } as ToolRunContext);
    expect(JSON.parse(result.output).forgotten).toBe(true);
    expect(forget).toHaveBeenCalledWith("guest-dm");
    expect(plugin.privateTools).toEqual([]);
  });
});
