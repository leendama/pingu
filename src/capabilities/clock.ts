import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, stringValue } from "../tools.js";

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
                type: "string",
                description: "IANA timezone name. Use the user's configured timezone unless they ask for another location.",
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
          const now = new Date();
          const formatter = new Intl.DateTimeFormat("en-AU", {
            timeZone: timezone,
            dateStyle: "full",
            timeStyle: "long",
            hour12: true,
          });
          return {
            output: JSON.stringify({
              timezone,
              local_time: formatter.format(now),
              iso_utc: now.toISOString(),
              unix_time_ms: now.getTime(),
            }),
          };
        },
      },
    ],
  );
}
