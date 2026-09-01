import "./env.js";
import { createAgentStarter } from "./agent-starter.js";
import { startAgent } from "./agent.js";
import { loadConfig, publicUrl, type AssistantConfig } from "./config.js";
import { settingsFromConfig, settingsFromEnvironment, type RuntimeSettings } from "./runtime-settings.js";
import { createSetupServer } from "./setup-server.js";

const startConfiguredAgent = createAgentStarter<AssistantConfig, RuntimeSettings>({
  buildSettings: (config) => config
    ? settingsFromConfig(config, `${publicUrl()}/auth/google/callback`)
    : settingsFromEnvironment(),
  startAgent,
  onExit: (error) => {
    if (error) console.error("Assistant runtime stopped:", error instanceof Error ? error.message : String(error));
    else console.error("Assistant message stream ended. The process will restart.");
    process.exit(1);
  },
});

const locallyConfigured = Boolean(process.env.PROJECT_ID && process.env.PROJECT_SECRET && process.env.OPENAI_API_KEY);
if (locallyConfigured && !process.env.PHOTON_SETUP_TOKEN) {
  const outcome = startConfiguredAgent();
  if (!outcome.started) {
    console.error("Assistant could not start:", outcome.reason === "invalid-settings" ? outcome.message : outcome.reason);
    process.exit(1);
  }
} else {
  const port = Number(process.env.PORT || 3000);
  createSetupServer(startConfiguredAgent).listen(port, "0.0.0.0", () => {
    console.log(`Setup wizard listening on port ${port}.`);
  });
  void loadConfig().then((config) => {
    if (!config?.google.refreshToken) return;
    const outcome = startConfiguredAgent(config);
    if (!outcome.started && outcome.reason === "invalid-settings") {
      console.error("Saved configuration could not start the assistant:", outcome.message);
    }
  }).catch((error) => {
    console.error("Saved configuration could not be loaded:", error instanceof Error ? error.message : String(error));
  });
}
