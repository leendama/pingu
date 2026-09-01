export interface RunningAgentLike {
  done: Promise<void>;
}

export type StartOutcome =
  | { started: true }
  | { started: false; reason: "already-running" }
  | { started: false; reason: "invalid-settings"; message: string };

export interface AgentStarterOptions<TConfig, TSettings> {
  buildSettings(config?: TConfig): TSettings;
  startAgent(settings: TSettings): Promise<RunningAgentLike>;
  /** Called when the runtime ends: a startup rejection, the message stream ending, or a runtime error. */
  onExit(error?: unknown): void;
}

/**
 * Start-once latch for the agent. A failed settings build or startup rejection
 * releases the latch so a later attempt (for example after the user fixes the
 * wizard form) can try again instead of being refused forever.
 */
export function createAgentStarter<TConfig, TSettings>(
  options: AgentStarterOptions<TConfig, TSettings>,
): (config?: TConfig) => StartOutcome {
  let running = false;
  let starting = false;
  return (config) => {
    if (running || starting) return { started: false, reason: "already-running" };
    starting = true;
    let settings: TSettings;
    try {
      settings = options.buildSettings(config);
    } catch (error) {
      starting = false;
      return {
        started: false,
        reason: "invalid-settings",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    options.startAgent(settings).then(
      (agent) => {
        running = true;
        starting = false;
        agent.done.then(() => options.onExit(), (error) => options.onExit(error));
      },
      (error) => {
        starting = false;
        options.onExit(error);
      },
    );
    return { started: true };
  };
}
