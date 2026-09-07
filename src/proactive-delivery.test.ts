import { describe, expect, it, vi } from "vitest";
import { deliverToOwner } from "./proactive-delivery.js";

describe("deliverToOwner", () => {
  it("delivers only after checking the current owner list and direct-chat kind", async () => {
    const send = vi.fn(async () => undefined);
    await deliverToOwner({ ownerSpaces: async () => ["owner-dm"], conversationKind: async () => "dm", send }, "owner-dm", "Morning");
    expect(send).toHaveBeenCalledWith("owner-dm", "Morning");
  });

  it("fails closed for removed owners, groups, and unknown chats", async () => {
    const send = vi.fn(async () => undefined);
    await expect(deliverToOwner({ ownerSpaces: async () => [], conversationKind: async () => "dm", send }, "old", "Private")).rejects.toThrow(/not a current verified owner/);
    await expect(deliverToOwner({ ownerSpaces: async () => ["group"], conversationKind: async () => "group", send }, "group", "Private")).rejects.toThrow(/direct chat/);
    await expect(deliverToOwner({ ownerSpaces: async () => ["mystery"], conversationKind: async () => "unknown", send }, "mystery", "Private")).rejects.toThrow(/direct chat/);
    expect(send).not.toHaveBeenCalled();
  });
});
