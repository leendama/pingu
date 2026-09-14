# Plugins

A plugin exports an `AssistantPlugin` with OpenAI function schemas and a `run` handler. Public plugins can be added to `src/community-plugins.ts`. Keep personal plugins outside the repository and set `PINGU_PLUGIN_DIR` to that directory. Each external `.ts`, `.js`, or `.mjs` file must export one plugin as its default export or an array named `plugins`.

```ts
const weatherPlugin = {
  id: "weather",
  name: "Weather",
  tools: [{
    type: "function",
    name: "get_weather",
    description: "Get current weather.",
    strict: true,
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
      additionalProperties: false,
    },
  }],
  readOnlyTools: ["get_weather"],
  groupSafeTools: ["get_weather"],
  async run(name, argumentsJson, context) {
    const args = JSON.parse(argumentsJson) as { location: string };
    return { output: JSON.stringify({ location: args.location, temperature: 20 }) };
  },
};

export default weatherPlugin;
```

## Who can call a tool

New tools start as private and side-effecting. A private tool exists only in the verified owner's direct messages: it is left out of the model's tool list for guests and for every group, and a direct call is refused.

| Field | Meaning |
|---|---|
| `groupSafeTools` | Not private. Offered to guests and in groups as well as to the owner. |
| `readOnlyTools` | Safe to retry after a model failure. |
| `guestOnlyTools` | Offered only when the sender is a guest, never to the owner. |
| `directOnlyTools` | Offered only in direct messages. |
| `groupOnlyTools` | Offered only inside a group chat. |
| `untrustedSourceTools` | Returns content written by third parties. After one runs, deletes in the same turn need the owner's yes. |

`context.role` is `"owner"` or `"guest"`, `context.senderId` is the sender id Spectrum reported (undefined when it recorded none), and `context.isGroup` says whether the chat is a group. Use `context.untrustedContentSeen` and `context.confirmedActionKey` if your tool does something destructive: arm a confirmation with `armPendingAction` and act only when the key comes back on the next message.

Plugins run as trusted server code. Check the source and dependencies before installing one.

## Draft results and compatibility

Email tools create drafts for manual review and sending in Gmail. There is no `send_gmail_draft` or `review_gmail_draft` tool. Do not instruct the assistant to ask for send confirmation.

Prefer delegating to `gmailPlugin(port).run("create_gmail_draft", argumentsJson, context)`. It verifies the draft where the port supports read-back and returns a self-contained `draftPreview` containing `draftId`, `to`, `cc`, `bcc`, `subject` and `body`. The registry passes that preview to the message pipeline, which displays it without a pending-email store. A plugin must return preview data only after successful draft creation.

The older `draftCreated` result is deprecated. If a compatible pending lookup exists, its matching preview can still be displayed. If the lookup is missing, unavailable or points to a different draft, Pingu reports that a draft was created and directs the owner to Gmail. It does not recreate the draft or pretend that creation failed. Legacy confirmation fields and stores are compatibility APIs; the production agent does not wire an email-send confirmation flow.

Integration tests should use the real registry and message pipeline with fake external services, including the production configuration without optional legacy dependencies. Testing a plugin only with a mocked pending store misses this compatibility failure.
