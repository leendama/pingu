import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import type { CalendarPort } from "./capabilities/calendar.js";
import { gmailBodyText, type GmailPort } from "./capabilities/gmail.js";
import type { JsonObject } from "./tools.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import { googleCredentialsPath, googleTokenPath } from "./private-paths.js";

export const googleScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

export function googleOAuthClient(
  credentials: { clientId: string; clientSecret: string },
  redirectUri: string,
) {
  return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, redirectUri);
}

const cachedClients = new Map<string, ReturnType<typeof createGoogleClient>>();

async function createGoogleClient(credentials?: RuntimeSettings["google"]) {
  let clientId = credentials?.clientId;
  let clientSecret = credentials?.clientSecret;
  let redirectUri = credentials?.redirectUri;
  let token: Record<string, unknown> = { refresh_token: credentials?.refreshToken };
  if (!clientId || !clientSecret) {
    const credentials = JSON.parse(await readFile(googleCredentialsPath(), "utf8"));
    const keys = credentials.installed ?? credentials.web;
    clientId = keys.client_id;
    clientSecret = keys.client_secret;
    redirectUri = keys.redirect_uris[0];
    token = JSON.parse(await readFile(googleTokenPath(), "utf8"));
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials(token);
  return { calendar: google.calendar({ version: "v3", auth }), gmail: google.gmail({ version: "v1", auth }) };
}

export async function googleClient(credentials?: RuntimeSettings["google"]) {
  const key = credentials ? JSON.stringify(credentials) : "local-files";
  let cachedClient = cachedClients.get(key);
  if (!cachedClient) {
    cachedClient = createGoogleClient(credentials).catch((error) => {
      cachedClients.delete(key);
      throw error;
    });
    cachedClients.set(key, cachedClient);
  }
  return cachedClient.catch((error) => {
    cachedClients.delete(key);
    throw error;
  });
}

export function googleCalendarPort(credentials?: RuntimeSettings["google"]): CalendarPort {
  return {
    async listEvents(params) {
      const { calendar } = await googleClient(credentials);
      const result = await calendar.events.list({
        calendarId: "primary",
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        q: params.query,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 25,
      });
      return result.data.items ?? [];
    },
    async insertEvent(requestBody: JsonObject, sendUpdates) {
      const { calendar } = await googleClient(credentials);
      return (await calendar.events.insert({ calendarId: "primary", sendUpdates, requestBody })).data;
    },
    async patchEvent(eventId: string, requestBody: JsonObject, sendUpdates) {
      const { calendar } = await googleClient(credentials);
      return (await calendar.events.patch({ calendarId: "primary", eventId, sendUpdates, requestBody })).data;
    },
    async deleteEvent(eventId, sendUpdates) {
      const { calendar } = await googleClient(credentials);
      await calendar.events.delete({ calendarId: "primary", eventId, sendUpdates });
    },
  };
}

export function googleGmailPort(credentials?: RuntimeSettings["google"]): GmailPort {
  return {
    async searchMessages(query, maxResults) {
      const { gmail } = await googleClient(credentials);
      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
      return Promise.all((list.data.messages ?? []).map(async ({ id }) => {
        const response = await gmail.users.messages.get({
          userId: "me",
          id: id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        const headers = Object.fromEntries(
          (response.data.payload?.headers ?? []).map((header) => [header.name?.toLowerCase(), header.value]),
        );
        return { id, ...headers, snippet: response.data.snippet };
      }));
    },
    async readMessage(messageId) {
      const { gmail } = await googleClient(credentials);
      const response = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const headers = Object.fromEntries(
        (response.data.payload?.headers ?? []).map((header) => [header.name?.toLowerCase(), header.value]),
      );
      return {
        id: response.data.id,
        threadId: response.data.threadId,
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        subject: headers.subject,
        date: headers.date,
        snippet: response.data.snippet,
        body: gmailBodyText(response.data.payload),
      };
    },
    async createDraft(raw) {
      const { gmail } = await googleClient(credentials);
      const response = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
      if (!response.data.id) throw new Error("Gmail did not return a draft ID.");
      return response.data.id;
    },
    async sendDraft(draftId) {
      const { gmail } = await googleClient(credentials);
      const response = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
      return { messageId: response.data.id, threadId: response.data.threadId };
    },
  };
}
