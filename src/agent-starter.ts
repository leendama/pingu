export interface RunningAgentLike {
  done: Promise<void>;
}

export type StartOutcome =
  | { started: true }
  | { started: false; reason: "already-running" }
  | { started: false; reason: "invalid-settings"; message: string }
  | { started: false; reason: "startup-failed"; message: string };

export interface AgentStarterOptions<TConfig, TSettings> {
  buildSettings(config?: TConfig): TSettings;
  startAgent(settings: TSettings): Promise<RunningAgentLike>;
  /** Called only after a successful start, when the runtime later ends or fails. */
  onExit(error?: unknown): void;
}

/**
 * Start-once latch for the agent. Startup is awaited, so callers see the real
 * outcome — a settings problem or a startup rejection releases the latch and
 * reports its reason, letting a later attempt (for example after the user
 * fixes the wizard form) try again instead of being refused forever.
 */
export function createAgentStarter<TConfig, TSettings>(
  options: AgentStarterOptions<TConfig, TSettings>,
): (config?: TConfig) => Promise<StartOutcome> {
  let running = false;
  let starting = false;
  return async (config) => {
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
    let agent: RunningAgentLike;
    try {
      agent = await options.startAgent(settings);
    } catch (error) {
      starting = false;
      return {
        started: false,
        reason: "startup-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    running = true;
    starting = false;
    agent.done.then(() => options.onExit(), (error) => options.onExit(error));
    return { started: true };
  };
}
