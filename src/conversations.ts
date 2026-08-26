import { JsonFileStore } from "./state.js";

type ConversationState = Record<string, string>;

const store = new JsonFileStore<ConversationState>(
  "conversations.json",
  () => ({}),
  (value) => value && typeof value === "object" ? value as ConversationState : {},
);

export async function getConversationId(spaceId: string): Promise<string | undefined> {
  return (await store.read())[spaceId];
}

export async function setConversationId(spaceId: string, conversationId: string): Promise<void> {
  await store.update((state) => {
    state[spaceId] = conversationId;
    return { result: undefined, changed: true };
  });
}

export async function clearConversationId(spaceId: string): Promise<void> {
  await store.update((state) => {
    const changed = spaceId in state;
    delete state[spaceId];
    return { result: undefined, changed };
  });
}
