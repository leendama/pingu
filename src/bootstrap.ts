import "./env.js";
import { startAgent, type RunningAgent } from "./agent.js";
import { loadConfig, publicUrl, type AssistantConfig } from "./config.js";
import { settingsFromConfig, settingsFromEnvironment } from "./runtime-settings.js";
import { createSetupServer } from "./setup-server.js";

let running: RunningAgent | undefined;
let starting = false;

function startConfiguredAgent(config?: AssistantConfig): boolean {
  if (running || starting) return false;
  starting = true;
  const settings = config
    ? settingsFromConfig(config, `${publicUrl()}/auth/google/callback`)
    : settingsFromEnvironment();
  void startAgent(settings).then((agent) => {
    running = agent;
    starting = false;
    return agent.done;
  }).then(
    () => {
      console.error("Assistant message stream ended. The process will restart.");
      process.exit(1);
    },
    (error) => {
      console.error("Assistant runtime stopped:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
  return true;
}

const locallyConfigured = Boolean(process.env.PROJECT_ID && process.env.PROJECT_SECRET && process.env.OPENAI_API_KEY);
if (locallyConfigured && !process.env.PHOTON_SETUP_TOKEN) {
  startConfiguredAgent();
} else {
  const port = Number(process.env.PORT || 3000);
  createSetupServer(startConfiguredAgent).listen(port, "0.0.0.0", () => {
    console.log(`Setup wizard listening on port ${port}.`);
  });
  void loadConfig().then((config) => {
    if (config?.google.refreshToken) startConfiguredAgent(config);
  }).catch((error) => {
    console.error("Saved configuration could not be loaded:", error instanceof Error ? error.message : String(error));
  });
}
