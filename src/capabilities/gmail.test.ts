import { describe, expect, it } from "vitest";
import type { PendingEmail } from "../pending-emails.js";
import type { ToolRunContext } from "../plugins.js";
import {
  appendPinguSignature,
  boundedGmailBody,
  GMAIL_BODY_CHAR_LIMIT,
  gmailBodyText,
  gmailPlugin,
  PINGU_EMAIL_SIGNATURE,
  type GmailMessagePart,
  type GmailPort,
  type PendingEmailStore,
} from "./gmail.js";

function fakePort(state: { raws: string[]; sent: string[] }): GmailPort {
  return {
    async searchMessages() { return []; },
    async readMessage(messageId) {
      return { id: messageId, from: "Sender <sender@example.com>", subject: "Project update", body: "Complete message body." };
    },
    async createDraft(raw) {
      state.raws.push(raw);
      return `draft-${state.raws.length}`;
    },
    async sendDraft(draftId) {
      state.sent.push(draftId);
      return { messageId: "msg-1", threadId: "thread-1" };
    },
  };
}

function fakeStore(): PendingEmailStore & { byId: Map<string, PendingEmail> } {
  const byId = new Map<string, PendingEmail>();
  return {
    byId,
    async set(email) { byId.set(email.spaceId, email); },
    async get(spaceId) { return byId.get(spaceId); },
    async clear(spaceId, draftId) {
      if (byId.get(spaceId)?.draftId === draftId) byId.delete(spaceId);
    },
  };
}

function chatContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return { isGroup: false, spaceId: "space-1", ...overrides } as ToolRunContext;
}

const draftArgs = {
  to: ["friend@example.com"], cc: [], bcc: [],
  subject: "Lunch", body: "Midday tomorrow?",
};

describe("gmailPlugin", () => {
  it("reads the complete message selected from search results", async () => {
    const plugin = gmailPlugin(fakePort({ raws: [], sent: [] }), fakeStore());

    const result = await plugin.run("read_gmail_message", JSON.stringify({ message_id: "message-1" }), chatContext());

    expect(JSON.parse(result.output).message).toMatchObject({
      id: "message-1",
      subject: "Project update",
      body: "Complete message body.",
    });
  });

  it("extracts full plain text from nested MIME parts and falls back to HTML", () => {
    const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    expect(gmailBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encoded("First line.\nSecond line.") } },
        { mimeType: "text/html", body: { data: encoded("<p>Ignored HTML.</p>") } },
      ],
    })).toBe("First line.\nSecond line.");
    expect(gmailBodyText({ mimeType: "text/html", body: { data: encoded("<p>Hello &amp; welcome.</p><p>Next line.</p>") } }))
      .toBe("Hello & welcome.\nNext line.");
  });

  it("caps an oversized body and marks it truncated", () => {
    const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    const huge = "x".repeat(GMAIL_BODY_CHAR_LIMIT + 5_000);
    const bounded = boundedGmailBody({ mimeType: "text/plain", body: { data: encoded(huge) } });
    expect(bounded.truncated).toBe(true);
    expect(bounded.body).toContain("[Truncated: the full message is");
    expect(bounded.body.length).toBeLessThan(GMAIL_BODY_CHAR_LIMIT + 200);

    const small = boundedGmailBody({ mimeType: "text/plain", body: { data: encoded("short") } });
    expect(small).toEqual({ body: "short", truncated: false });
  });

  it("stops descending into MIME parts past the depth limit", () => {
    const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    let payload: GmailMessagePart = { mimeType: "text/plain", body: { data: encoded("too deep") } };
    for (let level = 0; level < 15; level += 1) payload = { mimeType: "multipart/mixed", parts: [payload] };
    expect(gmailBodyText(payload)).toBe("");
  });

  it("creates a draft, stores it pending, and reports draftCreated to the loop", async () => {
    const state = { raws: [], sent: [] };
    const store = fakeStore();
    const plugin = gmailPlugin(fakePort(state), store);

    const result = await plugin.run("create_gmail_draft", JSON.stringify(draftArgs), chatContext());
    expect(result.draftCreated).toBe("draft-1");
    const payload = JSON.parse(result.output);
    expect(payload).toMatchObject({ created: true, draft_id: "draft-1", confirmation_required_to_send: true });
    expect(payload.body).toBe(`Midday tomorrow?\n\n${PINGU_EMAIL_SIGNATURE}`);
    expect(store.byId.get("space-1")).toMatchObject({
      draftId: "draft-1",
      subject: "Lunch",
      body: `Midday tomorrow?\n\n${PINGU_EMAIL_SIGNATURE}`,
    });
    const rawEmail = Buffer.from(state.raws[0]!, "base64url").toString("utf8");
    const encodedParts = rawEmail.match(/Content-Transfer-Encoding: base64\r\n\r\n([^\r]+)/g) ?? [];
    const decodedParts = encodedParts.map((part) => Buffer.from(part.split("\r\n\r\n")[1]!, "base64").toString("utf8"));
    expect(decodedParts[0]).toBe(
      "Midday tomorrow?\n\nthis email was composed by Pingu (https://github.com/leendama/pingu), noot noot",
    );
    expect(decodedParts[1]).toContain(
      'this email was composed by <a href="https://github.com/leendama/pingu"',
    );
  });

  it("adds the Pingu signature once", () => {
    expect(appendPinguSignature("Hello\n\n")).toBe(`Hello\n\n${PINGU_EMAIL_SIGNATURE}`);
    expect(appendPinguSignature(`Hello\n\n${PINGU_EMAIL_SIGNATURE}`)).toBe(
      `Hello\n\n${PINGU_EMAIL_SIGNATURE}`,
    );
    expect(appendPinguSignature(" ")).toBe(PINGU_EMAIL_SIGNATURE);
  });

  it("requires at least one recipient", async () => {
    const plugin = gmailPlugin(fakePort({ raws: [], sent: [] }), fakeStore());
    const result = await plugin.run("create_gmail_draft", JSON.stringify({ ...draftArgs, to: [] }), chatContext());
    expect(JSON.parse(result.output).error).toMatch(/recipient is required/);
  });

  it("strips header injection from recipients and subject", async () => {
    const state = { raws: [], sent: [] };
    const plugin = gmailPlugin(fakePort(state), fakeStore());
    await plugin.run("create_gmail_draft", JSON.stringify({
      ...draftArgs,
      to: ["victim@example.com\r\nBcc: attacker@evil.example"],
      subject: "Hello\r\nX-Injected: yes",
    }), chatContext());
    const raw = Buffer.from(state.raws[0]!, "base64url").toString("utf8");
    const headerSection = raw.split("\r\n\r\n")[0]!;
    expect(headerSection).not.toMatch(/^Bcc: attacker/m);
    expect(headerSection).not.toMatch(/^X-Injected/m);
  });

  it("refuses to send without a pending draft or without an explicit confirmation", async () => {
    const state = { raws: [], sent: [] };
    const store = fakeStore();
    const plugin = gmailPlugin(fakePort(state), store);

    const notPending = await plugin.run("send_gmail_draft", JSON.stringify({ draft_id: "draft-9" }), chatContext());
    expect(JSON.parse(notPending.output).error).toMatch(/not awaiting confirmation/);

    await plugin.run("create_gmail_draft", JSON.stringify(draftArgs), chatContext());
    const unconfirmed = await plugin.run("send_gmail_draft", JSON.stringify({ draft_id: "draft-1" }), chatContext());
    expect(JSON.parse(unconfirmed.output).error).toMatch(/blocked until the user confirms/);
    expect(state.sent).toEqual([]);
  });

  it("sends a confirmed draft and clears the pending record", async () => {
    const state = { raws: [], sent: [] };
    const store = fakeStore();
    const plugin = gmailPlugin(fakePort(state), store);
    await plugin.run("create_gmail_draft", JSON.stringify(draftArgs), chatContext());

    const result = await plugin.run(
      "send_gmail_draft",
      JSON.stringify({ draft_id: "draft-1" }),
      chatContext({ confirmedEmailDraftId: "draft-1" }),
    );
    expect(JSON.parse(result.output)).toEqual({ sent: true, message_id: "msg-1", thread_id: "thread-1" });
    expect(state.sent).toEqual(["draft-1"]);
    expect(store.byId.has("space-1")).toBe(false);
  });

  it("review re-displays the pending draft and reopens the confirmation window", async () => {
    const store = fakeStore();
    const plugin = gmailPlugin(fakePort({ raws: [], sent: [] }), store);
    await plugin.run("create_gmail_draft", JSON.stringify(draftArgs), chatContext());

    const review = await plugin.run("review_gmail_draft", JSON.stringify({ draft_id: "draft-1" }), chatContext());
    expect(review.draftCreated).toBe("draft-1");
    expect(JSON.parse(review.output)).toMatchObject({ draft_id: "draft-1", subject: "Lunch" });

    const missing = await plugin.run("review_gmail_draft", JSON.stringify({ draft_id: "draft-9" }), chatContext());
    expect(JSON.parse(missing.output).error).toMatch(/not pending/);
  });

  it("declares sending and drafting as side effecting, searching and reviewing as read-only", () => {
    const plugin = gmailPlugin(fakePort({ raws: [], sent: [] }), fakeStore());
    expect(plugin.sideEffectingTools).toEqual(["create_gmail_draft", "send_gmail_draft"]);
    expect(plugin.privateTools).toEqual(["search_gmail", "read_gmail_message", "create_gmail_draft", "send_gmail_draft", "review_gmail_draft"]);
  });
});
