import type { Tool } from "openai/resources/responses/responses";
import type { PinguPlugin, PluginRunResult, ToolRunContext } from "./plugins.js";

export type { ToolRunContext } from "./plugins.js";

export type JsonObject = Record<string, unknown>;

type FunctionTool = Extract<Tool, { type: "function" }>;

/**
 * One tool, declared once: schema, privacy, mutability, and executor together.
 * `private` and `sideEffecting` default to true so an omission fails safe.
 * pure or group-safe tools must say so explicitly.
 */
export interface ToolDeclaration {
  schema: FunctionTool;
  /** Touches the owner's private account; the registry blocks it in group chats. Defaults to true. */
  private?: boolean;
  /** May mutate external or durable state; attempting it disables turn replay. Defaults to true. */
  sideEffecting?: boolean;
  /** Only meaningful inside a group chat; rejected elsewhere. Defaults to false. */
  groupOnly?: boolean;
  run(args: JsonObject, context: ToolRunContext): Promise<PluginRunResult>;
}

export function capabilityPlugin(
  meta: { id: string; name: string; description: string; instructions?: string[] },
  declarations: ToolDeclaration[],
): PinguPlugin {
  const byName = new Map(declarations.map((declaration) => [declaration.schema.name, declaration]));
  return {
    ...meta,
    tools: declarations.map((declaration) => declaration.schema),
    sideEffectingTools: declarations.filter((declaration) => declaration.sideEffecting !== false).map((declaration) => declaration.schema.name),
    privateTools: declarations.filter((declaration) => declaration.private !== false).map((declaration) => declaration.schema.name),
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
