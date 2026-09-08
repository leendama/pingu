import type { PinguPlugin } from "../plugins.js";
import type { PendingEmail } from "../pending-emails.js";
import { capabilityPlugin, cleanHeader, numberValue, stringArray, stringValue, type JsonObject } from "../tools.js";

export interface GmailPort {
  /** Search messages and return sender/subject/date/snippet summaries, already resolved. */
  searchMessages(query: string | undefined, maxResults: number): Promise<GmailMessageSummary[]>;
  /** Read one complete message, including its decoded text body. */
  readMessage(messageId: string): Promise<GmailMessage>;
  /** Read a thread in Gmail order when approval must prove its source is still current. */
  readThread?(threadId: string): Promise<GmailMessage[]>;
  /** Create a draft from a base64url RFC 2822 message and return its draft ID. */
  createDraft(raw: string, threadId?: string): Promise<string>;
  /** Read a draft back after creation so Pingu never claims an unverified outcome. */
  readDraft?(draftId: string): Promise<{ id?: string | null; message?: GmailMessage }>;
  /** Current Gmail mailbox history cursor, used for push-like incremental review. */
  getHistoryId?(): Promise<string>;
  /** Message IDs added since a cursor. Throws GmailHistoryExpiredError when Google has expired it. */
  listHistory?(startHistoryId: string): Promise<{ historyId: string; messageIds: string[] }>;
  /** Legacy compatibility only. Pingu never calls this to send mail. */
  sendDraft?(draftId: string): Promise<{ messageId?: string | null; threadId?: string | null }>;
}

export class GmailHistoryExpiredError extends Error {
  constructor() { super("Gmail's saved history cursor expired."); this.name = "GmailHistoryExpiredError"; }
}

export interface GmailMessageSummary {
  id?: string | null;
  threadId?: string | null;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  date?: string | null;
  snippet?: string | null;
  labelIds?: string[] | null;
}

export interface GmailMessage extends GmailMessageSummary {
  cc?: string | null;
  bcc?: string | null;
  messageIdHeader?: string | null;
  references?: string | null;
  /** RFC 3834 Auto-Submitted header, retained for deterministic automation filtering. */
  autoSubmitted?: string | null;
  precedence?: string | null;
  /** Mailing-list headers retained so bulk mail can be filtered before review. */
  listId?: string | null;
  listUnsubscribe?: string | null;
  body: string;
  /** True when the body was cut at GMAIL_BODY_CHAR_LIMIT. */
  truncated?: boolean;
}

export interface GmailMessagePart {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; attachmentId?: string | null } | null;
  parts?: GmailMessagePart[] | null;
}

export const PINGU_EMAIL_SIGNATURE = "this email was composed by [Pingu](https://github.com/leendama/pingu), noot noot";
const PINGU_URL = "https://github.com/leendama/pingu";
const EMAIL_BOUNDARY = "pingu_signature_boundary";

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const codePoint = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith("#") ? Number.parseInt(entity.slice(1), 10) : undefined;
    if (codePoint !== undefined) return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function gmailBodyText(payload?: GmailMessagePart | null): string {
  const plain: string[] = [];
  const html: string[] = [];
  function visit(part?: GmailMessagePart | null, depth = 0): void {
    if (!part || depth > 10) return;
    for (const child of part.parts ?? []) visit(child, depth + 1);
    if (!part.body?.data || part.body.attachmentId || part.filename) return;
    const decoded = Buffer.from(part.body.data, "base64url").toString("utf8");
    if (part.mimeType === "text/plain") plain.push(decoded);
    if (part.mimeType === "text/html") html.push(decoded);
  }
  visit(payload);
  return (plain.length ? plain.join("\n") : htmlToText(html.join("\n"))).trim();
}

/** Bounds what one email can push into the model's context window. */
export const GMAIL_BODY_CHAR_LIMIT = 20_000;

export function boundedGmailBody(payload?: GmailMessagePart | null): { body: string; truncated: boolean } {
  const full = gmailBodyText(payload);
  if (full.length <= GMAIL_BODY_CHAR_LIMIT) return { body: full, truncated: false };
  return {
    body: `${full.slice(0, GMAIL_BODY_CHAR_LIMIT)}\n\n[Truncated: the full message is ${full.length} characters. Tell the user the rest was cut off.]`,
    truncated: true,
  };
}

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

function decodeHeader(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_encoded, charset: string, encoding: string, payload: string) => {
    if (!/^utf-8$/i.test(charset)) return _encoded;
    if (encoding.toLowerCase() === "b") return Buffer.from(payload, "base64").toString("utf8");
    return payload.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_match: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  });
}

export function buildRawEmail(args: JsonObject): string {
  const bodies = emailBodies(typeof args.body === "string" ? args.body : "");
  const headers = [
    `To: ${stringArray(args.to).map(cleanHeader).join(", ")}`,
    ...(stringArray(args.cc).length ? [`Cc: ${stringArray(args.cc).map(cleanHeader).join(", ")}`] : []),
    ...(stringArray(args.bcc).length ? [`Bcc: ${stringArray(args.bcc).map(cleanHeader).join(", ")}`] : []),
    `Subject: ${encodeHeader(stringValue(args.subject) ?? "")}`,
    ...(stringValue(args.in_reply_to) ? [`In-Reply-To: ${cleanHeader(stringValue(args.in_reply_to)!)}`] : []),
    ...(stringValue(args.references) ? [`References: ${cleanHeader(stringValue(args.references)!)}`] : []),
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

function headerAddresses(value?: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/(?:<([^<>\s]+@[^<>\s]+)>|\b([^\s<>,;]+@[^\s<>,;]+)\b)/g)]
    .map((match) => (match[1] ?? match[2])!.toLowerCase()).sort();
}

function sameAddresses(actual: string | null | undefined, expected: string[]): boolean {
  return JSON.stringify(headerAddresses(actual)) === JSON.stringify(expected.map((value) => value.toLowerCase()).sort());
}

export async function createVerifiedGmailDraft(port: GmailPort, input: {
  to: string[]; cc: string[]; bcc: string[]; subject: string; body: string;
  threadId?: string; inReplyTo?: string; references?: string;
}): Promise<string> {
  const draftId = await port.createDraft(buildRawEmail({
    to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, body: input.body,
    in_reply_to: input.inReplyTo, references: input.references,
  }), input.threadId);
  if (!port.readDraft) return draftId;
  const readBack = await port.readDraft(draftId);
  const message = readBack.message;
  if (readBack.id !== draftId
    || !message
    || (input.threadId && message.threadId !== input.threadId)
    || !sameAddresses(message.to, input.to)
    || !sameAddresses(message.cc, input.cc)
    || !sameAddresses(message.bcc, input.bcc)
    || decodeHeader(message.subject) !== input.subject
    || !message.body.includes(input.body.trim())) {
    throw new Error("Gmail accepted the draft but its read-back did not match.");
  }
  return draftId;
}

export function gmailPlugin(port: GmailPort, _legacyPendingEmails?: PendingEmailStore): PinguPlugin {
  return capabilityPlugin(
    {
      id: "gmail",
      name: "Gmail",
      description: "Search, read, and draft email for the owner to send manually in Gmail.",
      instructions: [
        "Gmail search returns summaries with From and To headers. When the owner asks for someone's email address, or names an email recipient without an address, search Gmail before asking them for it. Search the inbox for mail from the person's name first; if needed, search sent and received mail by that name. Use an address only when the headers clearly associate it with that person. If there are no reliable matches, ask; if there are conflicting matches, show the short choices and ask which one.",
        "Call read_gmail_message with a result ID whenever the user asks to read, summarize, quote, or reply based on the full email.",
      ],
    },
    [
      {
        schema: {
          type: "function",
          name: "search_gmail",
          description: "Search the user's Gmail and return sender, recipient, subject, date, and snippet for matching messages. Also use this to find a person's email address from message headers before asking the owner for it.",
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
        untrustedSource: true,
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
          name: "read_gmail_message",
          description: "Read one complete Gmail message by ID, including its full decoded text body. Use an ID returned by search_gmail.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              message_id: { type: "string", description: "Gmail message ID returned by search_gmail." },
            },
            required: ["message_id"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        untrustedSource: true,
        run: async (args) => {
          const messageId = stringValue(args.message_id);
          if (!messageId) throw new Error("A Gmail message ID is required.");
          return { output: JSON.stringify({ message: await port.readMessage(messageId) }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "create_gmail_draft",
          description: "Create a Gmail draft for the owner to review and send manually in Gmail. Pingu never sends email.",
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
        safeAfterUntrusted: true,
        run: async (args) => {
          if (stringArray(args.to).length === 0) throw new Error("At least one recipient is required.");
          const rawBody = typeof args.body === "string" ? args.body : "";
          const body = appendPinguSignature(rawBody);
          const draftId = await createVerifiedGmailDraft(port, { to: stringArray(args.to), cc: stringArray(args.cc), bcc: stringArray(args.bcc), subject: stringValue(args.subject) ?? "", body: rawBody });
          return {
            output: JSON.stringify({
              created: true,
              draft_id: draftId,
              to: stringArray(args.to),
              cc: stringArray(args.cc),
              bcc: stringArray(args.bcc),
              subject: stringValue(args.subject) ?? "",
              body,
              manual_send_required: true,
              tell_the_owner: "The draft is ready in Gmail. Review it there and send it yourself when you are happy.",
            }),
          };
        },
      },
    ],
  );
}
/** Legacy store shape retained for third-party compile compatibility; no longer used by Pingu. */
export interface PendingEmailStore {
  set(email: PendingEmail): Promise<void>;
  get(spaceId: string): Promise<PendingEmail | undefined>;
  clear(spaceId: string, draftId: string): Promise<void>;
}
