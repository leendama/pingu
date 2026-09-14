import "./env.js";
import { createAgentStarter, type StartOutcome } from "./agent-starter.js";
import { startAgent } from "./agent.js";
import { spawn } from "node:child_process";
import { loadConfig, publicUrl, type AssistantConfig } from "./config.js";
import { ensureLocalSecrets, setupLink } from "./local-secrets.js";
import { settingsFromConfig, settingsFromEnvironment, type RuntimeSettings } from "./runtime-settings.js";
import { createSetupServer } from "./setup-server.js";

function failureMessage(outcome: StartOutcome & { started: false }): string {
  return outcome.reason === "already-running" ? "the assistant is already running" : outcome.message;
}

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
  void startConfiguredAgent().then((outcome) => {
    if (!outcome.started) {
      console.error("Assistant could not start:", failureMessage(outcome));
      process.exit(1);
    }
  });
} else {
  const port = Number(process.env.PORT || 3000);
  const secrets = await ensureLocalSecrets();
  createSetupServer(startConfiguredAgent).listen(port, "0.0.0.0", () => {
    if (secrets.generatedToken) {
      const link = setupLink();
      console.log(`\nOpen this link to set up Pingu:\n\n  ${link}\n\nIt signs you in to the wizard for this run only.`);
      if (process.platform === "darwin") spawn("open", [link], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
    } else {
      console.log(`Setup wizard listening on port ${port}.`);
    }
  });
  void loadConfig().then(async (config) => {
    if (!config?.google.refreshToken) return;
    const outcome = await startConfiguredAgent(config);
    if (!outcome.started && outcome.reason !== "already-running") {
      console.error("Saved configuration could not start the assistant:", outcome.message);
    }
  }).catch((error) => {
    console.error("Saved configuration could not be loaded:", error instanceof Error ? error.message : String(error));
  });
}
