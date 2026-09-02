import { JsonFileStore } from "./state.js";

/** Caps that protect the owner's model bill once anyone can text the number. */
export interface GuestSettings {
  /** Messages one unknown sender may send per UTC day. */
  dailyMessageCap: number;
  /** Model tokens all guests together may consume per UTC day; the global spend ceiling. */
  dailyTokenBudget: number;
  /** Active reminders one guest may hold. */
  maxReminders: number;
}

export const defaultGuestSettings: GuestSettings = {
  dailyMessageCap: 20,
  dailyTokenBudget: 300_000,
  maxReminders: 5,
};

interface GuestRecord {
  firstSeenAt: string;
  day: string;
  count: number;
}

interface GuestState {
  version: 1;
  senders: Record<string, GuestRecord>;
  usage: { day: string; tokens: number };
}

const store = new JsonFileStore<GuestState>(
  "guests.json",
  () => ({ version: 1, senders: {}, usage: { day: "", tokens: 0 } }),
  (value) => {
    const record = value && typeof value === "object" ? value as Partial<GuestState> : {};
    return {
      version: 1,
      senders: record.senders && typeof record.senders === "object" ? record.senders : {},
      usage: record.usage && typeof record.usage === "object" ? { day: String(record.usage.day ?? ""), tokens: Number(record.usage.tokens) || 0 } : { day: "", tokens: 0 },
    };
  },
);

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type GuestAdmission =
  | { allowed: true; firstContact: boolean; remaining: number }
  | { allowed: false; firstContact: boolean; reason: "sender-cap" | "budget" };

/** Count one inbound guest message and decide whether Pingu answers it. */
export async function admitGuestMessage(senderId: string, settings: GuestSettings, now = Date.now()): Promise<GuestAdmission> {
  const day = utcDay(now);
  return store.update<GuestAdmission>((state) => {
    const existing = state.senders[senderId];
    const firstContact = !existing;
    const record: GuestRecord = existing && existing.day === day
      ? existing
      : { firstSeenAt: existing?.firstSeenAt ?? new Date(now).toISOString(), day, count: 0 };
    state.senders[senderId] = record;
    if (state.usage.day !== day) state.usage = { day, tokens: 0 };
    if (state.usage.tokens >= settings.dailyTokenBudget) {
      return { result: { allowed: false, firstContact, reason: "budget" }, changed: true };
    }
    if (record.count >= settings.dailyMessageCap) {
      return { result: { allowed: false, firstContact, reason: "sender-cap" }, changed: true };
    }
    record.count += 1;
    return { result: { allowed: true, firstContact, remaining: settings.dailyMessageCap - record.count }, changed: true };
  });
}

/** Add a guest turn's token usage to today's global total. */
export async function recordGuestUsage(tokens: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const day = utcDay(now);
  await store.update((state) => {
    if (state.usage.day !== day) state.usage = { day, tokens: 0 };
    state.usage.tokens += Math.round(tokens);
    return { result: undefined, changed: true };
  });
}

export async function guestUsageToday(now = Date.now()): Promise<{ tokens: number; senders: number }> {
  const day = utcDay(now);
  const state = await store.read();
  return {
    tokens: state.usage.day === day ? state.usage.tokens : 0,
    senders: Object.values(state.senders).filter((record) => record.day === day).length,
  };
}

export function guestLimitMessage(reason: "sender-cap" | "budget", assistantName: string): string {
  return reason === "sender-cap"
    ? `You've reached today's message limit with ${assistantName}. Try again tomorrow.`
    : `${assistantName} is resting for the day. Try again tomorrow.`;
}

/** The one line an unknown sender sees before their first reply. */
export function firstContactDisclosure(assistantName: string, ownerName: string): string {
  return `Hi, I'm ${assistantName}, ${ownerName}'s assistant. I can show when ${ownerName} is free and pass on a meeting request. I can't share anything else from their accounts. Text me if you need to cancel a booking.`;
}
