import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, stringValue } from "../tools.js";
import { liveTime } from "../time-context.js";

export function clockPlugin(): PinguPlugin {
  return capabilityPlugin(
    { id: "clock", name: "Live clock", description: "Current date, time, and timezone awareness." },
    [
      {
        schema: {
          type: "function",
          name: "get_current_time",
          description: "Get the live current date and time in an IANA timezone. Always use this for current time, today's date, or relative dates such as today, tomorrow, and this week.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              timezone: {
                type: ["string", "null"],
                description: "Null uses the user's configured timezone. Supply an IANA timezone only when they ask for another location.",
              },
            },
            required: ["timezone"],
            additionalProperties: false,
          },
        },
        private: false,
        sideEffecting: false,
        run: async (args, context) => {
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          return {
            output: JSON.stringify(liveTime(timezone)),
          };
        },
      },
    ],
  );
}
