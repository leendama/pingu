import type { PendingEmail } from "../pending-emails.js";
import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, cleanHeader, numberValue, stringArray, stringValue, type JsonObject } from "../tools.js";

export interface GmailPort {
  /** Search messages and return sender/subject/date/snippet summaries, already resolved. */
  searchMessages(query: string | undefined, maxResults: number): Promise<GmailMessageSummary[]>;
  /** Create a draft from a base64url RFC 2822 message and return its draft ID. */
  createDraft(raw: string): Promise<string>;
  sendDraft(draftId: string): Promise<{ messageId?: string | null; threadId?: string | null }>;
}

export interface GmailMessageSummary {
  id?: string | null;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  date?: string | null;
  snippet?: string | null;
}

export interface PendingEmailStore {
  set(email: PendingEmail): Promise<void>;
  get(spaceId: string): Promise<PendingEmail | undefined>;
  clear(spaceId: string, draftId: string): Promise<void>;
}

export const PINGU_EMAIL_SIGNATURE = "this email was composed by [Pingu](https://github.com/leendama/pingu), noot noot";
const PINGU_URL = "https://github.com/leendama/pingu";
const EMAIL_BOUNDARY = "pingu_signature_boundary";

export function appendPinguSignature(body: string): string {
  const cleanBody = body.trimEnd();
  if (cleanBody.endsWith(PINGU_EMAIL_SIGNATURE)) return cleanBody;
  return cleanBody ? `${cleanBody}\n\n${PINGU_EMAIL_SIGNATURE}` : PINGU_EMAIL_SIGNATURE;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function emailBodies(body: string): { plain: string; html: string } {
  const content = body.endsWith(PINGU_EMAIL_SIGNATURE)
    ? body.slice(0, -PINGU_EMAIL_SIGNATURE.length).trimEnd()
    : body.trimEnd();
  const plainSignature = `this email was composed by Pingu (${PINGU_URL}), noot noot`;
  const plain = content ? `${content}\n\n${plainSignature}` : plainSignature;
  const htmlContent = content ? `<div>${escapeHtml(content).replaceAll("\n", "<br>")}</div>` : "";
  const htmlSignature = `<div style="margin-top:24px;font-size:12px;color:#777777">this email was composed by <a href="${PINGU_URL}" style="color:#777777">Pingu</a>, noot noot</div>`;
  return { plain, html: `${htmlContent}${htmlSignature}` };
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(cleanHeader(value), "utf8").toString("base64")}?=`;
}

export function buildRawEmail(args: JsonObject): string {
  const bodies = emailBodies(typeof args.body === "string" ? args.body : "");
  const headers = [
    `To: ${stringArray(args.to).map(cleanHeader).join(", ")}`,
    ...(stringArray(args.cc).length ? [`Cc: ${stringArray(args.cc).map(cleanHeader).join(", ")}`] : []),
    ...(stringArray(args.bcc).length ? [`Bcc: ${stringArray(args.bcc).map(cleanHeader).join(", ")}`] : []),
    `Subject: ${encodeHeader(stringValue(args.subject) ?? "")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${EMAIL_BOUNDARY}"`,
  ];
  const mimeBody = [
    `--${EMAIL_BOUNDARY}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(bodies.plain, "utf8").toString("base64"),
    `--${EMAIL_BOUNDARY}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(bodies.html, "utf8").toString("base64"),
    `--${EMAIL_BOUNDARY}--`,
  ].join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${mimeBody}`, "utf8").toString("base64url");
}

export function gmailPlugin(port: GmailPort, pendingEmails: PendingEmailStore): PinguPlugin {
  return capabilityPlugin(
    { id: "gmail", name: "Gmail", description: "Search, draft, review, and confirmation-gated sending." },
    [
      {
        schema: {
          type: "function",
          name: "search_gmail",
          description: "Search the user's Gmail and return sender, subject, date, and snippet for matching messages.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "A Gmail search query, such as from:, subject:, after:, or keywords." },
              max_results: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["query", "max_results"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        run: async (args) => {
          const messages = await port.searchMessages(
            stringValue(args.query),
            Math.min(Math.max(numberValue(args.max_results, 5), 1), 10),
          );
          return { output: JSON.stringify({ messages }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "create_gmail_draft",
          description: "Create a Gmail draft before any email can be sent. Return the full recipients, subject, and body for review and ask for a separate confirmation.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              to: { type: "array", items: { type: "string" } },
              cc: { type: "array", items: { type: "string" } },
              bcc: { type: "array", items: { type: "string" } },
              subject: { type: "string" },
              body: { type: "string", description: "Plain-text email body without a signature. Pingu adds its signature automatically." },
            },
            required: ["to", "cc", "bcc", "subject", "body"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          if (stringArray(args.to).length === 0) throw new Error("At least one recipient is required.");
          const body = appendPinguSignature(typeof args.body === "string" ? args.body : "");
          const draftId = await port.createDraft(buildRawEmail({ ...args, body }));
          await pendingEmails.set({
            spaceId: context.spaceId,
            draftId,
            to: stringArray(args.to),
            cc: stringArray(args.cc),
            bcc: stringArray(args.bcc),
            subject: stringValue(args.subject) ?? "",
            body,
            createdAt: new Date().toISOString(),
          });
          return {
            draftCreated: draftId,
            output: JSON.stringify({
              created: true,
              draft_id: draftId,
              to: stringArray(args.to),
              cc: stringArray(args.cc),
              bcc: stringArray(args.bcc),
              subject: stringValue(args.subject) ?? "",
              body,
              confirmation_required_to_send: true,
              confirmation_must_be_separate_message: true,
            }),
          };
        },
      },
      {
        schema: {
          type: "function",
          name: "send_gmail_draft",
          description: "Send the pending Gmail draft only after the user reviewed it and explicitly confirmed in a separate message. The server rejects same-turn or unconfirmed sends.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              draft_id: { type: "string" },
            },
            required: ["draft_id"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const draftId = stringValue(args.draft_id);
          if (!draftId) throw new Error("A Gmail draft ID is required.");
          const pending = await pendingEmails.get(context.spaceId);
          if (!pending || pending.draftId !== draftId) {
            throw new Error("That draft is not awaiting confirmation in this conversation. Show the draft first and ask the user to confirm.");
          }
          if (context.confirmedEmailDraftId !== draftId) {
            throw new Error("Email sending is blocked until the user confirms in a separate message after reviewing the draft.");
          }
          const sent = await port.sendDraft(draftId);
          await pendingEmails.clear(context.spaceId, draftId);
          return { output: JSON.stringify({ sent: true, message_id: sent.messageId, thread_id: sent.threadId }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "review_gmail_draft",
          description: "Re-display the complete pending Gmail draft and reopen confirmation when another user message intervened after the previous review. This never sends the draft.",
          strict: true,
          parameters: {
            type: "object",
            properties: { draft_id: { type: "string" } },
            required: ["draft_id"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        run: async (args, context) => {
          const draftId = stringValue(args.draft_id);
          const pending = await pendingEmails.get(context.spaceId);
          if (!draftId || !pending || pending.draftId !== draftId) {
            throw new Error("That draft is not pending in this conversation.");
          }
          return {
            draftCreated: draftId,
            output: JSON.stringify({
              draft_id: pending.draftId,
              to: pending.to,
              cc: pending.cc,
              bcc: pending.bcc,
              subject: pending.subject,
              body: pending.body,
              confirmation_required_to_send: true,
              confirmation_must_be_next_message: true,
            }),
          };
        },
      },
    ],
  );
}
