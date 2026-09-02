import "./env.js";
import { loadConfig, publicUrl } from "./config.js";
import { runDiagnostics } from "./diagnostics.js";
import { settingsFromConfig, settingsFromEnvironment, type RuntimeSettings } from "./runtime-settings.js";

const icons = { ok: "✓", failed: "✗", skipped: "–" } as const;

async function main(): Promise<void> {
  let settings: RuntimeSettings;
  try {
    const config = await loadConfig().catch(() => undefined);
    settings = config?.google.refreshToken
      ? settingsFromConfig(config, `${publicUrl()}/auth/google/callback`)
      : settingsFromEnvironment();
  } catch (error) {
    console.error(`✗ Configuration: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`Checking connections for ${settings.assistantName}…\n`);
  const checks = await runDiagnostics(settings);
  for (const check of checks) {
    console.log(`${icons[check.status]} ${check.label}: ${check.detail}`);
  }
  const failed = checks.filter((check) => check.status === "failed");
  console.log(failed.length ? `\n${failed.length} check(s) failed.` : "\nEverything that can be checked is working.");
  process.exit(failed.length ? 1 : 0);
}

void main();
