import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import type { StartOutcome } from "./agent-starter.js";
import { loadConfig, publicUrl, saveConfig, type AssistantConfig } from "./config.js";
import { runDiagnostics, type ConnectionCheck } from "./diagnostics.js";
import { googleOAuthClient, googleScopes } from "./google.js";
import { detectLocalModelEndpoint, preferredLocalModel, type LocalModelEndpoint } from "./local-models.js";
import { activeClaimCode, CLAIM_CODE_TTL_MS, issueClaimCode, listOwners, removeOwner, type OwnerRecord } from "./owners.js";
import { resolveGoogleClient } from "./runtime-settings.js";
import { runtimeStatus } from "./runtime-status.js";
import { isLoopbackUrl, sharedGoogleClient } from "./shared-google-client.js";
import { deleteAllPinguData } from "./transcripts.js";

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up Pingu</title><style>body{font:16px/1.5 system-ui;background:#f4f5f3;color:#17201d;margin:0}.wrap{max-width:700px;margin:40px auto;padding:16px}main{background:white;border:1px solid #d9ddd9;border-radius:18px;padding:32px}label{display:block;font-weight:650;margin-top:16px}label.inline{display:flex;gap:8px;align-items:center;font-weight:500}input,select{width:100%;box-sizing:border-box;padding:11px;border:1px solid #bcc5bf;border-radius:9px;font:inherit}input[type=checkbox]{width:auto}button,.button{display:inline-block;margin-top:22px;padding:11px 18px;border:0;border-radius:999px;background:#185c46;color:white;font-weight:700;text-decoration:none;font:inherit;cursor:pointer}button.quiet{background:#e9ede9;color:#17201d}button.danger{background:#a23b2a}.status{padding:12px;background:#eaf4ed;border-radius:10px}.warn{background:#fff0dc}.code{font:700 28px/1.2 ui-monospace,monospace;letter-spacing:.08em;padding:14px;background:#f0f1ef;border-radius:10px;text-align:center}ul.checks,ul.owners{list-style:none;padding:0}ul.checks li,ul.owners li{padding:10px 12px;border-radius:10px;margin:6px 0}.check-ok{background:#eaf4ed}.check-failed{background:#fde8e4}.check-skipped{background:#f0f1ef;color:#5c675f}ul.owners li{background:#f0f1ef;display:flex;justify-content:space-between;align-items:center;gap:12px}ul.owners form{margin:0}ul.owners button{margin:0;padding:6px 12px}small{color:#5c675f}code{overflow-wrap:anywhere}h2{margin-top:32px}</style></head><body><div class="wrap"><main>${body}</main></div></body></html>`;
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

function googleSection(config: AssistantConfig | undefined, callback: string): string {
  const shared = sharedGoogleClient();
  const ownFields = `<label>Client ID</label><input name="googleClientId" value="${escapeHtml(config?.google.clientId ?? "")}" ${shared ? "" : "required"}><label>Client secret</label><input type="password" name="googleClientSecret" placeholder="${config?.google.clientSecret ? "Leave blank to keep saved value" : ""}" ${shared || config?.google.clientSecret ? "" : "required"}>`;
  if (!shared) {
    return `<small>Create a Web OAuth client and add this authorised redirect URI:<br><code>${escapeHtml(callback)}</code><br>If the OAuth app stays in Testing, Google expires its sign-in after seven days; publish the app to keep Pingu connected.</small>${ownFields}`;
  }
  const loopback = isLoopbackUrl(publicUrl());
  return `<small>Pingu ships its own Google app, so no Google Cloud project is needed: leave these blank and choose <b>Connect Google</b>. Google shows an "unverified app" screen once; choose Continue. ${loopback ? "" : `That only works when this page is opened on the machine running Pingu (a localhost address). This host is <code>${escapeHtml(publicUrl())}</code>, so enter your own Web OAuth client below with redirect URI <code>${escapeHtml(callback)}</code>.`}</small><details${config?.google.clientId ? " open" : ""}><summary>Use your own Google project instead</summary>${ownFields}</details>`;
}

interface OwnerView {
  owners: OwnerRecord[];
  claim?: { code: string; expiresAt: string };
}

function renderOwners(view: OwnerView): string {
  const minutes = Math.round(CLAIM_CODE_TTL_MS / 60_000);
  const list = view.owners.length
    ? `<ul class="owners">${view.owners.map((owner) =>
      `<li><span><code>${escapeHtml(owner.senderId)}</code><br><small>verified ${escapeHtml(new Date(owner.verifiedAt).toLocaleString())}</small></span><form method="post" action="/setup/owners/remove"><input type="hidden" name="senderId" value="${escapeHtml(owner.senderId)}"><button class="quiet">Remove</button></form></li>`,
    ).join("")}</ul>`
    : `<p class="status warn">No verified owner yet. Until you text a claim code, every sender is treated as a guest and private tools stay off.</p>`;
  const claim = view.claim
    ? `<p>Text this code to your Pingu number within ${minutes} minutes (expires ${escapeHtml(new Date(view.claim.expiresAt).toLocaleTimeString())}):</p><p class="code">${escapeHtml(view.claim.code)}</p><small>The number that sends it is recorded as an owner by the exact id Spectrum reports. Typing a phone number here is never enough.</small>`
    : "";
  return `<h2>Who is the owner</h2>${list}${claim}<form method="post" action="/setup/claim"><button class="${view.claim ? "quiet" : ""}">${view.claim ? "Generate a new code" : "Show a claim code"}</button></form>`;
}

function renderLastStep(config: AssistantConfig | undefined, owners: OwnerView | undefined): string {
  if (!config?.google.refreshToken || !owners || owners.owners.length > 0 || !owners.claim) return "";
  const minutes = Math.round(CLAIM_CODE_TTL_MS / 60_000);
  return `<div class="status"><strong>Last step: text this code to your Pingu number from your own phone.</strong><p class="code">${escapeHtml(owners.claim.code)}</p><small>Valid ${minutes} minutes. The number that sends it becomes the owner, and this page flips to "Pingu is ready" when the first reply lands.</small></div>`;
}

function modelSection(config: AssistantConfig | undefined, local: LocalModelEndpoint | undefined): string {
  const detected = !config && local;
  const baseUrl = config?.openaiBaseUrl ?? (detected ? local.baseUrl : "");
  const model = config?.model ?? (detected ? preferredLocalModel(local.models) ?? "gpt-5.6-luna" : "gpt-5.6-luna");
  const note = detected
    ? `<p class="status">Found ${escapeHtml(local.name)} at <code>${escapeHtml(local.baseUrl)}</code>${local.models.length ? ` with ${escapeHtml(local.models.slice(0, 5).join(", "))}${local.models.length > 5 ? ", …" : ""}` : ""}. It is preselected; leave the API key blank to use it, or clear the endpoint to use OpenAI.</p>`
    : "";
  return `${note}<label>API key</label><input type="password" name="openaiApiKey" placeholder="${config ? "Leave blank to keep saved value" : detected ? "Not needed for a local model" : "sk-…"}" ${config || detected ? "" : "required"}><label>Model</label><input name="model" value="${escapeHtml(model)}" required>
  <label>Endpoint (optional)</label><input name="openaiBaseUrl" value="${escapeHtml(baseUrl)}" placeholder="Leave blank for OpenAI, or e.g. http://host.docker.internal:11434/v1 for Ollama"><small>Works with OpenAI and tested OpenAI Responses-compatible endpoints that support function calling (Ollama, LM Studio). Inside Docker, <code>localhost</code> is the container; a model on your Mac is <code>host.docker.internal</code>. Voice replies need OpenAI.</small>`;
}

function setup(config?: AssistantConfig, message = "", checks?: ConnectionCheck[], owners?: OwnerView, local?: LocalModelEndpoint): string {
  const callback = `${publicUrl()}/auth/google/callback`;
  const checked = (value: boolean | undefined, fallback: boolean) => (value ?? fallback) ? "checked" : "";
  return page(`<h1>Set up your assistant</h1><p>No source edits are required. Saved credentials are encrypted on the persistent disk.</p>${message ? `<p class="status">${escapeHtml(message)}</p>` : ""}${renderLastStep(config, owners)}${renderRuntime(config)}${renderChecks(checks)}<form method="post" action="/setup/save">
  <label>Assistant name</label><input name="assistantName" value="${escapeHtml(config?.assistantName || "Pingu")}" required>
  <label>Your name</label><input name="ownerName" value="${escapeHtml(config?.ownerName)}" required>
  <label>Timezone</label><input name="timezone" value="${escapeHtml(config?.timezone || "UTC")}" required>
  <h2>Photon Spectrum</h2><small>Create a project and attach an iMessage line at <a href="https://app.photon.codes" target="_blank" rel="noopener">app.photon.codes</a>, then paste its ID and secret. <b>Test connections</b> below checks that Photon accepts them; whether a line is attached is proven by Pingu replying to your text.</small><label>Project ID</label><input name="photonProjectId" value="${escapeHtml(config?.photonProjectId)}" required><label>Project secret</label><input type="password" name="photonProjectSecret" placeholder="${config ? "Leave blank to keep saved value" : ""}" ${config ? "" : "required"}>
  <h2>Model</h2>${modelSection(config, local)}
  <h2>Google</h2>${googleSection(config, callback)}
  <h2>Granola (optional)</h2><label>API key</label><input type="password" name="granolaApiKey" placeholder="${config ? "Leave blank to keep saved value" : ""}">
  <h2>Guests and bookings</h2><small>Anyone can text the number. Guests can chat, see your bookable windows, and request a meeting you approve by replying yes.</small>
  <label>Bookable hours</label><input name="bookableHours" value="${escapeHtml(config?.bookableHours ?? "09:00-17:00")}" placeholder="09:00-17:00 or 24h">
  <label>Bookable days</label><select name="bookableDays"><option value="weekdays" ${(config?.bookableDays ?? "weekdays") === "weekdays" ? "selected" : ""}>Weekdays</option><option value="all" ${config?.bookableDays === "all" ? "selected" : ""}>Every day</option></select>
  <label>Default meeting length (minutes)</label><input name="defaultMeetingMinutes" type="number" min="5" max="480" value="${escapeHtml(config?.defaultMeetingMinutes ?? 30)}">
  <label class="inline"><input type="checkbox" name="meetLink" ${checked(config?.meetLink, true)}> Add a Google Meet link to bookings</label>
  <label>Messages per guest per day</label><input name="guestDailyMessageCap" type="number" min="1" max="500" value="${escapeHtml(config?.guestDailyMessageCap ?? 20)}">
  <h2>Privacy</h2>
  <label>Keep chat history for (days)</label><input name="transcriptRetentionDays" type="number" min="0" max="3650" value="${escapeHtml(config?.transcriptRetentionDays ?? 30)}"><small>History is stored on this machine. Messages travel through Photon; prompts and the connector results they need go to the model endpoint above.</small>
  <label class="inline"><input type="checkbox" name="telemetry" ${checked(config?.telemetry, false)}> Send Spectrum SDK telemetry to Photon</label>
  <button>Save securely</button></form>
  ${config && !config.google.refreshToken ? `<a class="button" href="/auth/google">Connect Google</a>` : ""}${config?.google.refreshToken ? "<p class=\"status\">Google is connected.</p>" : ""}
  ${config ? `<form method="post" action="/setup/test"><button>Test connections</button></form>` : ""}
  ${owners ? renderOwners(owners) : ""}
  <h2>Delete all Pingu data</h2><small>Removes every chat transcript, reminder, alert, pending draft, guest record, verified owner, and booking request. Credentials stay so you are not signed out.</small><form method="post" action="/setup/data/delete"><label>Type DELETE to confirm</label><input name="confirm" autocomplete="off"><button class="danger">Delete data</button></form>`);
}

/** The client the wizard's OAuth flow uses. The shared installed-app client can only redirect to a loopback address. */
function googleClientForWizard(config: AssistantConfig) {
  const own = Boolean(config.google.clientId && config.google.clientSecret);
  if (!own && !isLoopbackUrl(publicUrl())) {
    throw new Error(`Pingu's shared Google app only works when the wizard is opened at a localhost address. This host is ${publicUrl()}; enter your own Google client ID and secret instead.`);
  }
  return resolveGoogleClient(config.google);
}

export function createSetupServer(onReady: (config: AssistantConfig) => Promise<StartOutcome>) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  async function ownerView(config?: AssistantConfig): Promise<OwnerView> {
    const owners = await listOwners();
    let claim = await activeClaimCode();
    // Google connected and nobody verified yet: the only thing left is the text, so put the code on screen unasked.
    if (owners.length === 0 && !claim && config?.google.refreshToken) claim = await issueClaimCode();
    return { owners, claim: claim ? { code: claim.code, expiresAt: claim.expiresAt } : undefined };
  }

  async function render(message = "", checks?: ConnectionCheck[]): Promise<string> {
    const config = await loadConfig().catch(() => undefined);
    const local = config ? undefined : await detectLocalModelEndpoint().catch(() => undefined);
    return setup(config, message, checks, await ownerView(config), local);
  }

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
  app.get("/setup/enter", (request, response) => {
    const supplied = typeof request.query.token === "string" ? request.query.token : "";
    if (!supplied || !safeEqual(supplied, setupToken())) return response.status(401).send(login("That setup link is not valid for this run. Restart Pingu and use the link it prints."));
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
    response.send(await render(message));
  });
  app.post("/setup/save", async (request, response) => {
    try {
      const existing = await loadConfig().catch(() => undefined);
      const body = request.body as Record<string, string | undefined>;
      const config = await saveConfig({
        assistantName: body.assistantName, ownerName: body.ownerName, timezone: body.timezone,
        photonProjectId: body.photonProjectId, photonProjectSecret: body.photonProjectSecret || existing?.photonProjectSecret,
        openaiApiKey: body.openaiApiKey || existing?.openaiApiKey || (body.openaiBaseUrl?.trim() ? "local" : undefined), model: body.model,
        openaiBaseUrl: body.openaiBaseUrl?.trim() || undefined,
        granolaApiKey: body.granolaApiKey || existing?.granolaApiKey || undefined,
        google: {
          clientId: body.googleClientId?.trim() || undefined,
          clientSecret: body.googleClientId?.trim() ? (body.googleClientSecret || existing?.google.clientSecret) : undefined,
          refreshToken: (body.googleClientId?.trim() || "") === (existing?.google.clientId ?? "") ? existing?.google.refreshToken : undefined,
        },
        telemetry: body.telemetry === "on",
        meetLink: body.meetLink === "on",
        guestDailyMessageCap: body.guestDailyMessageCap || undefined,
        transcriptRetentionDays: body.transcriptRetentionDays ?? undefined,
        bookableHours: body.bookableHours || undefined,
        bookableDays: body.bookableDays || undefined,
        defaultMeetingMinutes: body.defaultMeetingMinutes || undefined,
      });
      const outcome = config.google.refreshToken ? await onReady(config) : undefined;
      const message = !outcome
        ? "Saved. Connect Google to finish."
        : outcome.started
          ? "Saved and running."
          : outcome.reason === "already-running"
            ? "Saved. Restart the app to apply these settings."
            : `Saved, but the assistant could not start: ${outcome.message}`;
      response.send(setup(config, message, undefined, await ownerView(config)));
    } catch (error) {
      const message = error instanceof ZodError ? error.issues.map((issue) => issue.message).join(" ") : error instanceof Error ? error.message : "Setup failed.";
      response.status(400).send(await render(message));
    }
  });
  app.post("/setup/test", async (_request, response) => {
    const config = await loadConfig().catch(() => undefined);
    if (!config) return response.send(await render("Save your settings before testing connections."));
    const checks = await runDiagnostics({
      openaiApiKey: config.openaiApiKey,
      model: config.model,
      openaiBaseUrl: config.openaiBaseUrl,
      photonProjectId: config.photonProjectId,
      photonProjectSecret: config.photonProjectSecret,
      granolaApiKey: config.granolaApiKey,
      google: config.google.refreshToken
        ? { ...resolveGoogleClient(config.google), refreshToken: config.google.refreshToken }
        : undefined,
    });
    response.send(await render("", checks));
  });
  app.post("/setup/claim", async (_request, response) => {
    await issueClaimCode();
    response.send(await render("Text the claim code below from the phone that should own this assistant."));
  });
  app.post("/setup/owners/remove", async (request, response) => {
    const senderId = String((request.body as Record<string, unknown>).senderId || "");
    const removed = senderId ? await removeOwner(senderId) : false;
    response.send(await render(removed ? "Owner removed. That number is a guest again." : "That owner was not found."));
  });
  app.post("/setup/data/delete", async (request, response) => {
    const confirm = String((request.body as Record<string, unknown>).confirm || "");
    if (confirm !== "DELETE") return response.status(400).send(await render("Type DELETE to confirm. Nothing was deleted."));
    const result = await deleteAllPinguData();
    response.send(await render(`Deleted ${result.transcripts} chat transcript(s) and ${result.files.length} data file(s). Credentials were kept.`));
  });
  app.get("/auth/google", async (_request, response) => {
    const config = await loadConfig();
    if (!config) return response.redirect("/setup");
    let client;
    try {
      client = googleClientForWizard(config);
    } catch (error) {
      return response.status(400).send(await render(error instanceof Error ? error.message : "Google is not configured."));
    }
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString("base64url");
    const unsigned = `${timestamp}.${nonce}`;
    const auth = googleOAuthClient(client, `${publicUrl()}/auth/google/callback`);
    response.redirect(auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: googleScopes, state: `${unsigned}.${signature(unsigned)}` }));
  });
  app.get("/auth/google/callback", async (request, response) => {
    try {
      const config = await loadConfig();
      if (!config || typeof request.query.code !== "string" || typeof request.query.state !== "string") throw new Error("Google callback is missing required values.");
      const [timestamp, nonce, supplied] = request.query.state.split(".");
      const unsigned = `${timestamp}.${nonce}`;
      if (!timestamp || !nonce || !supplied || Date.now() - Number(timestamp) > 600_000 || !safeEqual(supplied, signature(unsigned))) throw new Error("Google OAuth state is invalid or expired.");
      const auth = googleOAuthClient(googleClientForWizard(config), `${publicUrl()}/auth/google/callback`);
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
