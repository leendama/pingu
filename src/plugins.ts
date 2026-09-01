import type { Tool } from "openai/resources/responses/responses";
import type { Message, Space } from "spectrum-ts";

export interface ToolRunContext {
  config: { timezone: string };
  spaceId: string;
  isGroup: boolean;
  space: Space;
  message: Message;
  sendVoice: (text: string) => Promise<void>;
  richResponseSent: boolean;
  draftForReview?: string;
  confirmedEmailDraftId?: string;
  sideEffectAttempted: boolean;
}

export interface PluginRunResult {
  output: string;
  delivered?: boolean;
  draftCreated?: string;
}

/** Clear per-attempt delivery outputs before a replay, so a stale draft or rich response cannot leak into the retry. */
export function resetAttemptOutputs(context: Pick<ToolRunContext, "richResponseSent" | "draftForReview">): void {
  context.richResponseSent = false;
  context.draftForReview = undefined;
}

export interface AssistantPlugin {
  id: string;
  name: string;
  description?: string;
  instructions?: string[];
  tools: Tool[];
  /** Explicit list used by capability modules. */
  privateTools?: string[];
  /** Explicit list used by capability modules. */
  sideEffectingTools?: string[];
  /** Community-plugin convenience. Tools remain private when this is omitted. */
  groupSafeTools?: string[];
  /** Community-plugin convenience. Tools remain side-effecting when this is omitted. */
  readOnlyTools?: string[];
  run(
    name: string,
    argumentsJson: string,
    context: ToolRunContext,
  ): Promise<PluginRunResult>;
}

export type PinguPlugin = AssistantPlugin;

export class PluginRegistry {
  readonly tools: Tool[] = [];
  readonly instructions: string[] = [];
  private readonly owners = new Map<string, AssistantPlugin>();
  private readonly privateNames = new Set<string>();
  private readonly sideEffects = new Set<string>();

  constructor(readonly plugins: AssistantPlugin[]) {
    for (const plugin of plugins) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id)) throw new Error(`Invalid plugin id: ${plugin.id}`);
      this.instructions.push(...(plugin.instructions ?? []));
      for (const tool of plugin.tools) {
        if (tool.type !== "function") throw new Error(`Plugin ${plugin.id} registered an unsupported tool type.`);
        if (this.owners.has(tool.name)) throw new Error(`Duplicate plugin tool: ${tool.name}`);
        this.owners.set(tool.name, plugin);
        this.tools.push(tool);
        const isPrivate = plugin.privateTools
          ? plugin.privateTools.includes(tool.name)
          : !plugin.groupSafeTools?.includes(tool.name);
        const isSideEffecting = plugin.sideEffectingTools
          ? plugin.sideEffectingTools.includes(tool.name)
          : !plugin.readOnlyTools?.includes(tool.name);
        if (isPrivate) this.privateNames.add(tool.name);
        if (isSideEffecting) this.sideEffects.add(tool.name);
      }
    }
  }

  async run(
    name: string,
    argumentsJson: string,
    context: ToolRunContext,
  ): Promise<{ handled: false } | { handled: true; output: string }> {
    const plugin = this.owners.get(name);
    if (!plugin) return { handled: false };
    if (context.isGroup && this.privateNames.has(name)) {
      return { handled: true, output: JSON.stringify({ error: "This tool accesses the owner's private account and is unavailable in group chats." }) };
    }
    if (this.sideEffects.has(name)) context.sideEffectAttempted = true;
    try {
      const result = await plugin.run(name, argumentsJson, context);
      if (result.delivered) context.richResponseSent = true;
      if (result.draftCreated) context.draftForReview = result.draftCreated;
      return { handled: true, output: result.output };
    } catch (error) {
      return { handled: true, output: JSON.stringify({ error: error instanceof Error ? error.message : "Plugin tool failed." }) };
    }
  }

  isPrivate(name: string): boolean {
    return this.privateNames.has(name);
  }

  isSideEffecting(name: string): boolean {
    return this.sideEffects.has(name);
  }
}
