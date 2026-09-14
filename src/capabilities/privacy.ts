import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin } from "../tools.js";

export interface PrivacyStore {
  forget(spaceId: string): Promise<void>;
}

/** Anyone may forget their own chat with Pingu. Deleting everything is a setup-page or CLI action, never a chat command. */
export function privacyPlugin(store: PrivacyStore): PinguPlugin {
  return capabilityPlugin(
    { id: "privacy", name: "Privacy", description: "Forget the current conversation." },
    [
      {
        schema: {
          type: "function",
          name: "forget_this_conversation",
          description: "Erase Pingu's stored history of the current chat when the person asks to forget, clear, or reset the conversation. Reminders and bookings are kept.",
          strict: true,
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
        private: false,
        run: async (_args, context) => {
          await store.forget(context.spaceId);
          return { output: JSON.stringify({ forgotten: true, note: "Tell the person the history of this chat has been erased and that this reply is the last thing you remember." }) };
        },
      },
    ],
  );
}
