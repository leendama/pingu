import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import type { StartOutcome } from "./agent-starter.js";
import { loadConfig, publicUrl, saveConfig, type AssistantConfig } from "./config.js";
import { runDiagnostics, type ConnectionCheck } from "./diagnostics.js";
import { googleOAuthClient, googleScopes } from "./google.js";
import { runtimeStatus } from "./runtime-status.js";

function setupToken(): string {
  const token = process.env.PHOTON_SETUP_TOKEN;
  if (!token || token.length < 20) throw new Error("PHOTON_SETUP_TOKEN must be at least 20 characters.");
  return token;
}

function signature(value: string): string {
  return createHmac("sha256", setupToken()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticated(cookie = ""): boolean {
  const value = cookie.match(/(?:^|;\s*)photon_setup=([^;]+)/)?.[1];
  if (!value) return false;
  const [issuedAt, supplied] = decodeURIComponent(value).split(".");
  return Boolean(issuedAt && supplied && safeEqual(supplied, signature(issuedAt)) && Date.now() - Number(issuedAt) < 86_400_000);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up Pingu</title><style>body{font:16px/1.5 system-ui;background:#f4f5f3;color:#17201d;margin:0}.wrap{max-width:700px;margin:40px auto;padding:16px}main{background:white;border:1px solid #d9ddd9;border-radius:18px;padding:32px}label{display:block;font-weight:650;margin-top:16px}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #bcc5bf;border-radius:9px;font:inherit}button,.button{display:inline-block;margin-top:22px;padding:11px 18px;border:0;border-radius:999px;background:#185c46;color:white;font-weight:700;text-decoration:none}.status{padding:12px;background:#eaf4ed;border-radius:10px}.warn{background:#fff0dc}ul.checks{list-style:none;padding:0}ul.checks li{padding:10px 12px;border-radius:10px;margin:6px 0}.check-ok{background:#eaf4ed}.check-failed{background:#fde8e4}.check-skipped{background:#f0f1ef;color:#5c675f}small{color:#5c675f}code{overflow-wrap:anywhere}</style></head><body><div class="wrap"><main>${body}</main></div></body></html>`;
}

function login(error = ""): string {
  return page(`<h1>Unlock setup</h1>${error ? `<p class="status warn">${escapeHtml(error)}</p>` : ""}<form method="post" action="/setup/login"><label>Setup token</label><input type="password" name="token" required><button>Continue</button></form>`);
}

function renderChecks(checks?: ConnectionCheck[]): string {
  if (!checks) return "";
  const icon = { ok: "✓", failed: "✗", skipped: "–" } as const;
  return `<h2>Connection tests</h2><ul class="checks">${checks.map((check) =>
    `<li class="check-${check.status}"><strong>${icon[check.status]} ${escapeHtml(check.label)}</strong> — ${escapeHtml(check.detail)}</li>`,
  ).join("")}</ul>`;
}

function renderRuntime(config?: AssistantConfig): string {
  if (!config?.google.refreshToken) return "";
  const status = runtimeStatus();
  if (!status.startedAt) return "";
  return status.lastReplyAt
    ? `<p class="status">Pingu is ready. It replied to a text at ${escapeHtml(new Date(status.lastReplyAt).toLocaleString())}.</p>`
    : `<p class="status">Pingu is running. Text your iMessage line — reload this page after it replies to confirm the whole chain works.</p>`;
}

function setup(config?: AssistantConfig, message = "", checks?: ConnectionCheck[]): string {
  const callback = `${publicUrl()}/auth/google/callback`;
  return page(`<h1>Set up your assistant</h1><p>No source edits are required. Saved credentials are encrypted on the persistent disk.</p>${message ? `<p class="status">${escapeHtml(message)}</p>` : ""}${renderRuntime(config)}${renderChecks(checks)}<form method="post" action="/setup/save">
  <label>Assistant name</label><input name="assistantName" value="${escapeHtml(config?.assistantName || "Pingu")}" required>
  <label>Your name</label><input name="ownerName" value="${escapeHtml(config?.ownerName)}" required>
  <label>Timezone</label><input name="timezone" value="${escapeHtml(config?.timezone || "UTC")}" required>
  <h2>Photon Spectrum</h2><label>Project ID</label><input name="photonProjectId" value="${escapeHtml(config?.photonProjectId)}" required><label>Project secret</label><input type="password" name="photonProjectSecret" placeholder="${config ? "Leave blank to keep saved value" : ""}" ${config ? "" : "required"}>
  <h2>OpenAI</h2><label>API key</label><input type="password" name="openaiApiKey" placeholder="${config ? "Leave blank to keep saved value" : "sk-…"}" ${config ? "" : "required"}><label>Model</label><input name="model" value="${escapeHtml(config?.model || "gpt-5.6-luna")}" required>
  <h2>Google</h2><small>Create a Web OAuth client and add this authorised redirect URI:<br><code>${escapeHtml(callback)}</code></small><label>Client ID</label><input name="googleClientId" value="${escapeHtml(config?.google.clientId)}" required><label>Client secret</label><input type="password" name="googleClientSecret" placeholder="${config ? "Leave blank to keep saved value" : ""}" ${config ? "" : "required"}>
  <h2>Granola (optional)</h2><label>API key</label><input type="password" name="granolaApiKey" placeholder="${config ? "Leave blank to keep saved value" : ""}"><button>Save securely</button></form>
  ${config && !config.google.refreshToken ? `<a class="button" href="/auth/google">Connect Google</a>` : ""}${config?.google.refreshToken ? "<p class=\"status\">Google is connected.</p>" : ""}
  ${config ? `<form method="post" action="/setup/test"><button>Test connections</button></form>` : ""}`);
}

export function createSetupServer(onReady: (config: AssistantConfig) => Promise<StartOutcome>) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.get("/healthz", async (_request, response) => {
    const config = await loadConfig().catch(() => undefined);
    // Booleans only: this route is unauthenticated, and exact activity
    // timestamps are personal. The setup page shows them behind the login.
    const status = runtimeStatus();
    response.json({
      ok: true,
      configured: Boolean(config),
      googleConnected: Boolean(config?.google.refreshToken),
      running: Boolean(status.startedAt),
      hasDeliveredReply: Boolean(status.lastReplyAt),
    });
  });
  app.post("/setup/login", (request, response) => {
    const supplied = String((request.body as Record<string, unknown>).token || "");
    if (!safeEqual(supplied, setupToken())) return response.status(401).send(login("Incorrect setup token."));
    const issuedAt = String(Date.now());
    response.setHeader("Set-Cookie", `photon_setup=${issuedAt}.${signature(issuedAt)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${publicUrl().startsWith("https://") ? "; Secure" : ""}`);
    response.redirect("/setup");
  });
  app.use((request, response, next) => {
    if (request.path === "/auth/google/callback" || request.path === "/healthz") return next();
    if (!authenticated(request.headers.cookie)) return response.status(401).send(login());
    next();
  });
  app.get(["/", "/setup"], async (request, response) => {
    const message = typeof request.query.failed === "string"
      ? `Google connected, but the assistant could not start: ${request.query.failed.slice(0, 300)}`
      : request.query.restart === "1"
        ? "Saved. Restart the app to apply these settings."
        : "";
    response.send(setup(await loadConfig().catch(() => undefined), message));
  });
  app.post("/setup/save", async (request, response) => {
    try {
      const existing = await loadConfig().catch(() => undefined);
      const body = request.body as Record<string, string>;
      const config = await saveConfig({
        assistantName: body.assistantName, ownerName: body.ownerName, timezone: body.timezone,
        photonProjectId: body.photonProjectId, photonProjectSecret: body.photonProjectSecret || existing?.photonProjectSecret,
        openaiApiKey: body.openaiApiKey || existing?.openaiApiKey, model: body.model,
        granolaApiKey: body.granolaApiKey || existing?.granolaApiKey || undefined,
        google: { clientId: body.googleClientId, clientSecret: body.googleClientSecret || existing?.google.clientSecret, refreshToken: body.googleClientId === existing?.google.clientId ? existing?.google.refreshToken : undefined },
      });
      const outcome = config.google.refreshToken ? await onReady(config) : undefined;
      const message = !outcome
        ? "Saved. Connect Google to finish."
        : outcome.started
          ? "Saved and running."
          : outcome.reason === "already-running"
            ? "Saved. Restart the app to apply these settings."
            : `Saved, but the assistant could not start: ${outcome.message}`;
      response.send(setup(config, message));
    } catch (error) {
      const message = error instanceof ZodError ? error.issues.map((issue) => issue.message).join(" ") : error instanceof Error ? error.message : "Setup failed.";
      response.status(400).send(setup(await loadConfig().catch(() => undefined), message));
    }
  });
  app.post("/setup/test", async (_request, response) => {
    const config = await loadConfig().catch(() => undefined);
    if (!config) return response.send(setup(undefined, "Save your settings before testing connections."));
    const checks = await runDiagnostics({
      openaiApiKey: config.openaiApiKey,
      model: config.model,
      granolaApiKey: config.granolaApiKey,
      google: config.google.refreshToken
        ? { clientId: config.google.clientId, clientSecret: config.google.clientSecret, refreshToken: config.google.refreshToken }
        : undefined,
    });
    response.send(setup(config, "", checks));
  });
  app.get("/auth/google", async (_request, response) => {
    const config = await loadConfig();
    if (!config) return response.redirect("/setup");
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString("base64url");
    const unsigned = `${timestamp}.${nonce}`;
    const auth = googleOAuthClient(config.google, `${publicUrl()}/auth/google/callback`);
    response.redirect(auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: googleScopes, state: `${unsigned}.${signature(unsigned)}` }));
  });
  app.get("/auth/google/callback", async (request, response) => {
    try {
      const config = await loadConfig();
      if (!config || typeof request.query.code !== "string" || typeof request.query.state !== "string") throw new Error("Google callback is missing required values.");
      const [timestamp, nonce, supplied] = request.query.state.split(".");
      const unsigned = `${timestamp}.${nonce}`;
      if (!timestamp || !nonce || !supplied || Date.now() - Number(timestamp) > 600_000 || !safeEqual(supplied, signature(unsigned))) throw new Error("Google OAuth state is invalid or expired.");
      const auth = googleOAuthClient(config.google, `${publicUrl()}/auth/google/callback`);
      const { tokens } = await auth.getToken(request.query.code);
      const refreshToken = tokens.refresh_token || config.google.refreshToken;
      if (!refreshToken) throw new Error("Google did not return a refresh token. Remove the app from Google account access and try again.");
      const updated = await saveConfig({ ...config, google: { ...config.google, refreshToken } });
      const outcome = await onReady(updated);
      response.redirect(
        outcome.started
          ? "/setup"
          : outcome.reason === "already-running"
            ? "/setup?restart=1"
            : `/setup?failed=${encodeURIComponent(outcome.message.slice(0, 300))}`,
      );
    } catch (error) {
      response.status(400).send(page(`<h1>Google connection failed</h1><p class="status warn">${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p><a class="button" href="/setup">Back</a>`));
    }
  });
  return app;
}
