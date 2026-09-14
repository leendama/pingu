export interface ProactiveDeliveryDeps {
  ownerSpaces(): Promise<string[]>;
  conversationKind(spaceId: string): Promise<"dm" | "group" | "unknown" | undefined>;
  send(spaceId: string, text: string): Promise<void>;
}

/** Every proactive private message re-checks its destination immediately before delivery. */
export async function deliverToOwner(
  deps: ProactiveDeliveryDeps,
  spaceId: string,
  text: string,
): Promise<void> {
  const owners = await deps.ownerSpaces();
  if (!owners.includes(spaceId)) throw new Error("The proactive message target is not a current verified owner chat.");
  if (await deps.conversationKind(spaceId) !== "dm") throw new Error("Private proactive messages require a verified direct chat.");
  await deps.send(spaceId, text);
}
