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
