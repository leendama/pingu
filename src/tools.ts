import type { Tool } from "openai/resources/responses/responses";
import type { PinguPlugin, PluginRunResult, ToolRunContext } from "./plugins.js";

export type { ToolRunContext } from "./plugins.js";

export type JsonObject = Record<string, unknown>;

type FunctionTool = Extract<Tool, { type: "function" }>;

/**
 * One tool, declared once: schema, privacy, mutability, audience, and executor together.
 * `private` and `sideEffecting` default to true so an omission fails safe.
 * pure or group-safe tools must say so explicitly.
 */
export interface ToolDeclaration {
  schema: FunctionTool;
  /** Touches the owner's private account; exists only in the verified owner's direct messages. Defaults to true. */
  private?: boolean;
  /** May mutate external or durable state; attempting it disables turn replay. Defaults to true. */
  sideEffecting?: boolean;
  /** Only offered to guests, never to the owner. Defaults to false. */
  guestOnly?: boolean;
  /** Only the verified owner may call it, in any chat. Independent of `private`. Defaults to false. */
  ownerOnly?: boolean;
  /** May still run after third-party content was read this turn, because it changes nothing outside review. Defaults to false. */
  safeAfterUntrusted?: boolean;
  /** Only offered in direct messages, never in groups. Defaults to false. */
  directOnly?: boolean;
  /** Only meaningful inside a group chat; rejected elsewhere. Defaults to false. */
  groupOnly?: boolean;
  /** Returns content written by third parties (email, meeting notes). Defaults to false. */
  untrustedSource?: boolean;
  run(args: JsonObject, context: ToolRunContext): Promise<PluginRunResult>;
}

export function capabilityPlugin(
  meta: { id: string; name: string; description: string; instructions?: string[] },
  declarations: ToolDeclaration[],
): PinguPlugin {
  const byName = new Map(declarations.map((declaration) => [declaration.schema.name, declaration]));
  const names = (predicate: (declaration: ToolDeclaration) => boolean) =>
    declarations.filter(predicate).map((declaration) => declaration.schema.name);
  return {
    ...meta,
    tools: declarations.map((declaration) => declaration.schema),
    sideEffectingTools: names((declaration) => declaration.sideEffecting !== false),
    privateTools: names((declaration) => declaration.private !== false),
    guestOnlyTools: names((declaration) => declaration.guestOnly === true),
    ownerOnlyTools: names((declaration) => declaration.ownerOnly === true),
    safeAfterUntrustedTools: names((declaration) => declaration.safeAfterUntrusted === true),
    directOnlyTools: names((declaration) => declaration.directOnly === true),
    groupOnlyTools: names((declaration) => declaration.groupOnly === true),
    untrustedSourceTools: names((declaration) => declaration.untrustedSource === true),
    async run(toolName, argumentsJson, context) {
      const declaration = byName.get(toolName);
      if (!declaration) return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }) };
      try {
        if (declaration.groupOnly && !context.isGroup) {
          throw new Error("This action is only available inside an iMessage group chat.");
        }
        return await declaration.run(JSON.parse(argumentsJson) as JsonObject, context);
      } catch (error) {
        console.error("Agent tool failed:", {
          tool: toolName,
          message: error instanceof Error ? error.message : String(error),
        });
        return { output: JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." }) };
      }
    },
  };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Collapse CR/LF so a model-supplied value cannot inject extra headers into mail or API payloads. */
export function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Strip control characters, collapse whitespace, and cap length before text authored by a guest reaches a calendar or email field. */
export function sanitiseText(value: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}\u2026` : cleaned;
}
