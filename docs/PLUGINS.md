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
  async run(name, argumentsJson) {
    const args = JSON.parse(argumentsJson) as { location: string };
    return { output: JSON.stringify({ location: args.location, temperature: 20 }) };
  },
};

export default weatherPlugin;
```

New tools start as private and side-effecting. Add a tool to `groupSafeTools` when group use is safe. Add it to `readOnlyTools` when retrying it is safe. Plugins run as trusted server code. Check the source and dependencies before installing one.
