import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import type { CalendarPort } from "./capabilities/calendar.js";
import { boundedGmailBody, GmailHistoryExpiredError, type GmailPort } from "./capabilities/gmail.js";
import { isMissingGoogleResource } from "./google-errors.js";
import type { JsonObject } from "./tools.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import { googleCredentialsPath, googleTokenPath } from "./private-paths.js";
import { ownCredentialsFileExists, sharedGoogleClient } from "./shared-google-client.js";

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

async function createGoogleAuth(credentials?: RuntimeSettings["google"]) {
  let clientId = credentials?.clientId;
  let clientSecret = credentials?.clientSecret;
  let redirectUri = credentials?.redirectUri;
  let token: Record<string, unknown> = { refresh_token: credentials?.refreshToken };
  if (!clientId || !clientSecret) {
    const shared = ownCredentialsFileExists() ? undefined : sharedGoogleClient();
    if (shared) {
      clientId = shared.clientId;
      clientSecret = shared.clientSecret;
      redirectUri = "http://localhost";
    } else {
      const credentials = JSON.parse(await readFile(googleCredentialsPath(), "utf8"));
      const keys = credentials.installed ?? credentials.web;
      clientId = keys.client_id;
      clientSecret = keys.client_secret;
      redirectUri = keys.redirect_uris[0];
    }
    token = JSON.parse(await readFile(googleTokenPath(), "utf8"));
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials(token);
  return auth;
}

async function createGoogleClient(credentials?: RuntimeSettings["google"]) {
  const auth = await createGoogleAuth(credentials);
  return { calendar: google.calendar({ version: "v3", auth }), gmail: google.gmail({ version: "v1", auth }) };
}

/** Refresh an access token and report which OAuth scopes Google actually granted. Throws when the sign-in is no longer valid. */
export async function googleGrantedScopes(credentials?: RuntimeSettings["google"]): Promise<string[]> {
  const auth = await createGoogleAuth(credentials);
  const token = await auth.getAccessToken();
  if (!token.token) throw new Error("Google did not return an access token.");
  return (await auth.getTokenInfo(token.token)).scopes ?? [];
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
  let cachedTimezone: Promise<string | undefined> | undefined;
  return {
    getTimezone() {
      // events.list works with the calendar.events scope Pingu requests and
      // reports the calendar's timezone; calendars.get would need a broader
      // calendar metadata scope and fail on a healthy connection.
      cachedTimezone ??= (async () => {
        const { calendar } = await googleClient(credentials);
        const result = await calendar.events.list({ calendarId: "primary", maxResults: 1 });
        return result.data.timeZone ?? undefined;
      })().catch((error) => {
        console.warn("Calendar timezone lookup failed:", error instanceof Error ? error.message : String(error));
        cachedTimezone = undefined;
        return undefined;
      });
      return cachedTimezone;
    },
    async listEvents(params) {
      const { calendar } = await googleClient(credentials);
      const events = [];
      let pageToken: string | undefined;
      do {
        const result = await calendar.events.list({
          calendarId: "primary",
          timeMin: params.timeMin,
          timeMax: params.timeMax,
          q: params.query,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 2500,
          pageToken,
        });
        events.push(...(result.data.items ?? []));
        pageToken = result.data.nextPageToken ?? undefined;
      } while (pageToken);
      return events;
    },
    async getEvent(eventId) {
      const { calendar } = await googleClient(credentials);
      try {
        return (await calendar.events.get({ calendarId: "primary", eventId })).data;
      } catch (error) {
        const status = typeof error === "object" && error && "code" in error ? Number(error.code) : undefined;
        if (status === 404 || status === 410) return undefined;
        throw error;
      }
    },
    async insertEvent(requestBody: JsonObject, sendUpdates, options) {
      const { calendar } = await googleClient(credentials);
      return (await calendar.events.insert({
        calendarId: "primary",
        sendUpdates,
        requestBody,
        ...(options?.conferenceDataVersion ? { conferenceDataVersion: options.conferenceDataVersion } : {}),
      })).data;
    },
    async patchEvent(eventId: string, requestBody: JsonObject, sendUpdates, options) {
      const { calendar } = await googleClient(credentials);
      return (await calendar.events.patch(
        { calendarId: "primary", eventId, sendUpdates, requestBody },
        options?.expectedEtag ? { headers: { "If-Match": options.expectedEtag } } : undefined,
      )).data;
    },
    async deleteEvent(eventId, sendUpdates) {
      const { calendar } = await googleClient(credentials);
      await calendar.events.delete({ calendarId: "primary", eventId, sendUpdates });
    },
  };
}

export function googleGmailPort(credentials?: RuntimeSettings["google"]): GmailPort {
  return {
    async getHistoryId() {
      const { gmail } = await googleClient(credentials);
      const historyId = (await gmail.users.getProfile({ userId: "me" })).data.historyId;
      if (!historyId) throw new Error("Gmail did not return a history cursor.");
      return historyId;
    },
    async listHistory(startHistoryId) {
      const { gmail } = await googleClient(credentials);
      const messageIds = new Set<string>();
      let pageToken: string | undefined;
      let historyId = startHistoryId;
      try {
        do {
          const response = await gmail.users.history.list({ userId: "me", startHistoryId, historyTypes: ["messageAdded"], pageToken, maxResults: 500 });
          for (const entry of response.data.history ?? []) {
            for (const added of entry.messagesAdded ?? []) if (added.message?.id) messageIds.add(added.message.id);
          }
          historyId = response.data.historyId ?? historyId;
          pageToken = response.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (error) {
        const status = typeof error === "object" && error && "code" in error ? Number(error.code) : undefined;
        if (status === 404) throw new GmailHistoryExpiredError();
        throw error;
      }
      return { historyId, messageIds: [...messageIds] };
    },
    async searchMessages(query, maxResults) {
      const { gmail } = await googleClient(credentials);
      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
      const found = await Promise.all((list.data.messages ?? []).map(async ({ id }) => {
        try {
          const response = await gmail.users.messages.get({
            userId: "me",
            id: id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Bcc", "Subject", "Date"],
          });
          const headers = Object.fromEntries(
            (response.data.payload?.headers ?? []).map((header) => [header.name?.toLowerCase(), header.value]),
          );
          return { id, threadId: response.data.threadId, ...headers, snippet: response.data.snippet, labelIds: response.data.labelIds };
        } catch (error) {
          // A message can disappear between listing and metadata retrieval.
          if (isMissingGoogleResource(error)) return undefined;
          throw error;
        }
      }));
      return found.filter((message): message is NonNullable<typeof message> => Boolean(message));
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
        bcc: headers.bcc,
        messageIdHeader: headers["message-id"],
        references: headers.references,
        autoSubmitted: headers["auto-submitted"],
        precedence: headers.precedence,
        listId: headers["list-id"],
        listUnsubscribe: headers["list-unsubscribe"],
        subject: headers.subject,
        date: headers.date,
        ...(response.data.internalDate ? { receivedAt: new Date(Number(response.data.internalDate)).toISOString() } : {}),
        snippet: response.data.snippet,
        labelIds: response.data.labelIds,
        ...boundedGmailBody(response.data.payload),
      };
    },
    async readThread(threadId) {
      const { gmail } = await googleClient(credentials);
      const response = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      return (response.data.messages ?? []).map((message) => {
        const headers = Object.fromEntries((message.payload?.headers ?? []).map((header) => [header.name?.toLowerCase(), header.value]));
        return {
          id: message.id, threadId: message.threadId, from: headers.from, to: headers.to, cc: headers.cc,
          bcc: headers.bcc, messageIdHeader: headers["message-id"], references: headers.references, autoSubmitted: headers["auto-submitted"], precedence: headers.precedence, listId: headers["list-id"], listUnsubscribe: headers["list-unsubscribe"], subject: headers.subject, date: headers.date,
          snippet: message.snippet, labelIds: message.labelIds, ...boundedGmailBody(message.payload),
        };
      });
    },
    async createDraft(raw, threadId) {
      const { gmail } = await googleClient(credentials);
      const response = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } } });
      if (!response.data.id) throw new Error("Gmail did not return a draft ID.");
      return response.data.id;
    },
    async readDraft(draftId) {
      const { gmail } = await googleClient(credentials);
      const response = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
      const message = response.data.message;
      const headers = Object.fromEntries((message?.payload?.headers ?? []).map((header) => [header.name?.toLowerCase(), header.value]));
      return { id: response.data.id, message: {
        id: message?.id, threadId: message?.threadId, from: headers.from, to: headers.to, cc: headers.cc, bcc: headers.bcc,
        subject: headers.subject, date: headers.date, messageIdHeader: headers["message-id"], references: headers.references,
        snippet: message?.snippet, labelIds: message?.labelIds, ...boundedGmailBody(message?.payload),
      } };
    },
  };
}
