import { randomUUID } from "node:crypto";
import { startPoller } from "./poller.js";
import { JsonFileStore } from "./state.js";

/** The email fields an alert delivery needs — a narrow view any Gmail search result satisfies. */
export interface AlertEmail {
  id?: string | null;
  from?: string | null;
  subject?: string | null;
  snippet?: string | null;
}

export interface EmailAlert {
  id: string;
  spaceId: string;
  gmailQuery: string;
  label: string;
  createdAt: string;
  seenMessageIds: string[];
}

export interface EmailAlertStore {
  create(input: Omit<EmailAlert, "id" | "createdAt">): Promise<{ alert: EmailAlert; created: boolean }>;
  list(spaceId: string): Promise<EmailAlert[]>;
  listAll(): Promise<EmailAlert[]>;
  cancel(spaceId: string, alertId: string): Promise<boolean>;
  markSeen(alertId: string, messageId: string): Promise<void>;
}

const store = new JsonFileStore<EmailAlert[]>(
  "email-alerts.json",
  () => [],
  (value) => Array.isArray(value) ? value as EmailAlert[] : [],
);

export const emailAlertStore: EmailAlertStore = {
  async create(input) {
    const gmailQuery = input.gmailQuery.replace(/[\r\n]+/g, " ").trim();
    if (!gmailQuery) throw new Error("A Gmail sender query is required.");
    return store.update<{ alert: EmailAlert; created: boolean }>((alerts) => {
      const existing = alerts.find((alert) => alert.spaceId === input.spaceId && alert.gmailQuery === gmailQuery);
      if (existing) return { result: { alert: existing, created: false }, changed: false };
      const alert: EmailAlert = {
        ...input,
        gmailQuery,
        label: input.label.trim() || gmailQuery,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      alerts.push(alert);
      return { result: { alert, created: true }, changed: true };
    });
  },
  async list(spaceId) {
    return (await store.read()).filter((alert) => alert.spaceId === spaceId);
  },
  async listAll() {
    return store.read();
  },
  async cancel(spaceId, alertId) {
    return store.update((alerts) => {
      const index = alerts.findIndex((alert) => alert.id === alertId && alert.spaceId === spaceId);
      if (index < 0) return { result: false, changed: false };
      alerts.splice(index, 1);
      return { result: true, changed: true };
    });
  },
  async markSeen(alertId, messageId) {
    await store.update((alerts) => {
      const alert = alerts.find((candidate) => candidate.id === alertId);
      if (!alert || alert.seenMessageIds.includes(messageId)) return { result: undefined, changed: false };
      alert.seenMessageIds.push(messageId);
      alert.seenMessageIds = alert.seenMessageIds.slice(-100);
      return { result: undefined, changed: true };
    });
  },
};

export async function processEmailAlerts(
  alerts: EmailAlertStore,
  search: (query: string, maxResults: number) => Promise<AlertEmail[]>,
  deliver: (alert: EmailAlert, message: AlertEmail) => Promise<void>,
): Promise<void> {
  for (const alert of await alerts.listAll()) {
    const after = Math.floor(Date.parse(alert.createdAt) / 1000);
    let messages: AlertEmail[];
    try {
      messages = await search(`${alert.gmailQuery} after:${after}`, 10);
    } catch (error) {
      console.error("Email alert search failed:", { alertId: alert.id, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const message of [...messages].reverse()) {
      const messageId = message.id;
      if (!messageId || alert.seenMessageIds.includes(messageId)) continue;
      try {
        await deliver(alert, message);
        await alerts.markSeen(alert.id, messageId);
      } catch (error) {
        console.error("Email alert delivery failed:", { alertId: alert.id, messageId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

export function startEmailAlertScheduler(
  alerts: EmailAlertStore,
  search: (query: string, maxResults: number) => Promise<AlertEmail[]>,
  deliver: (alert: EmailAlert, message: AlertEmail) => Promise<void>,
  intervalMs = 60_000,
): () => void {
  return startPoller("Email alert scheduler", intervalMs, () => processEmailAlerts(alerts, search, deliver));
}
