import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, numberValue, stringValue } from "../tools.js";

export interface GranolaPort {
  listNotes(options: { createdAfter?: string; createdBefore?: string; pageSize: number }): Promise<unknown>;
  getNote(noteId: string, includeTranscript: boolean): Promise<unknown>;
}

export function granolaPlugin(port: GranolaPort): PinguPlugin {
  return capabilityPlugin(
    { id: "granola", name: "Granola", description: "Read meeting notes and transcripts." },
    [
      {
        schema: {
          type: "function",
          name: "list_granola_notes",
          description: "List recent Granola meeting notes, optionally constrained by creation date.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              created_after: { type: ["string", "null"], description: "Optional YYYY-MM-DD lower bound." },
              created_before: { type: ["string", "null"], description: "Optional YYYY-MM-DD upper bound." },
              page_size: { type: "integer", minimum: 1, maximum: 30 },
            },
            required: ["created_after", "created_before", "page_size"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        untrustedSource: true,
        run: async (args) => ({
          output: JSON.stringify(await port.listNotes({
            createdAfter: stringValue(args.created_after),
            createdBefore: stringValue(args.created_before),
            pageSize: numberValue(args.page_size, 10),
          })),
        }),
      },
      {
        schema: {
          type: "function",
          name: "get_granola_note",
          description: "Read one Granola meeting note by ID, optionally including its transcript.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              note_id: { type: "string" },
              include_transcript: { type: "boolean" },
            },
            required: ["note_id", "include_transcript"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        untrustedSource: true,
        run: async (args) => ({
          output: JSON.stringify(await port.getNote(
            stringValue(args.note_id) ?? "",
            args.include_transcript === true,
          )),
        }),
      },
    ],
  );
}
