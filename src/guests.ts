import { JsonFileStore } from "./state.js";

/** Caps that protect the owner's model bill once anyone can text the number. */
export interface GuestSettings {
  /** Messages one unknown sender may send per UTC day. Every message in a burst counts. */
  dailyMessageCap: number;
  /** Model tokens all guests together may consume per UTC day; the global spend ceiling. */
  dailyTokenBudget: number;
  /** Active reminders one guest may hold, across every chat. */
  maxReminders: number;
  /** Longest combined inbound text a guest turn may carry. */
  maxInboundChars: number;
  /** Tokens reserved against the budget before a guest turn runs; the most one turn is allowed to cost. */
  maxTurnTokens: number;
  /** Tool rounds a guest turn may take before Pingu gives up. */
  maxToolRounds: number;
}

export const defaultGuestSettings: GuestSettings = {
  dailyMessageCap: 20,
  dailyTokenBudget: 300_000,
  maxReminders: 5,
  maxInboundChars: 2_000,
  maxTurnTokens: 20_000,
  maxToolRounds: 4,
};

interface GuestRecord {
  firstSeenAt: string;
  day: string;
  count: number;
}

interface GuestState {
  version: 1;
  senders: Record<string, GuestRecord>;
  usage: { day: string; tokens: number; reserved: number };
}

const store = new JsonFileStore<GuestState>(
  "guests.json",
  () => ({ version: 1, senders: {}, usage: { day: "", tokens: 0, reserved: 0 } }),
  (value) => {
    const record = value && typeof value === "object" ? value as Partial<GuestState> : {};
    const usage = record.usage && typeof record.usage === "object" ? record.usage : undefined;
    return {
      version: 1,
      senders: record.senders && typeof record.senders === "object" ? record.senders : {},
      usage: { day: String(usage?.day ?? ""), tokens: Number(usage?.tokens) || 0, reserved: Number(usage?.reserved) || 0 },
    };
  },
);

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type GuestAdmission =
  | { allowed: true; firstContact: boolean; remaining: number }
  | { allowed: false; firstContact: boolean; reason: "sender-cap" | "budget" };

export interface AdmissionOptions {
  now?: number;
  /** Inbound messages in this turn; each one counts against the sender's cap. */
  messages?: number;
  /** Tokens to hold against today's budget until `releaseGuestReservation` runs. */
  reserveTokens?: number;
}

/**
 * Count a guest turn and decide whether Pingu answers it. The budget check
 * includes tokens already reserved by turns still running, so simultaneous
 * guests cannot slip past the ceiling together.
 */
export async function admitGuestMessage(senderId: string, settings: GuestSettings, options: AdmissionOptions = {}): Promise<GuestAdmission> {
  const now = options.now ?? Date.now();
  const messages = Math.max(1, options.messages ?? 1);
  const reserve = Math.max(0, options.reserveTokens ?? 0);
  const day = utcDay(now);
  return store.update<GuestAdmission>((state) => {
    const existing = state.senders[senderId];
    const firstContact = !existing;
    const record: GuestRecord = existing && existing.day === day
      ? existing
      : { firstSeenAt: existing?.firstSeenAt ?? new Date(now).toISOString(), day, count: 0 };
    state.senders[senderId] = record;
    if (state.usage.day !== day) state.usage = { day, tokens: 0, reserved: 0 };
    if (record.count >= settings.dailyMessageCap) {
      return { result: { allowed: false, firstContact, reason: "sender-cap" }, changed: true };
    }
    if (state.usage.tokens + state.usage.reserved + reserve > settings.dailyTokenBudget) {
      return { result: { allowed: false, firstContact, reason: "budget" }, changed: true };
    }
    record.count += messages;
    state.usage.reserved += reserve;
    return { result: { allowed: true, firstContact, remaining: Math.max(0, settings.dailyMessageCap - record.count) }, changed: true };
  });
}

/** Give back a reservation once the turn has finished; actual usage was recorded per response as it happened. */
export async function releaseGuestReservation(reserveTokens: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(reserveTokens) || reserveTokens <= 0) return;
  const day = utcDay(now);
  await store.update((state) => {
    if (state.usage.day !== day) return { result: undefined, changed: false };
    state.usage.reserved = Math.max(0, state.usage.reserved - reserveTokens);
    return { result: undefined, changed: true };
  });
}

/** Add one model response's tokens to today's global total. Called for every response, including turns that later fail. */
export async function recordGuestUsage(tokens: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const day = utcDay(now);
  await store.update((state) => {
    if (state.usage.day !== day) state.usage = { day, tokens: 0, reserved: 0 };
    state.usage.tokens += Math.round(tokens);
    return { result: undefined, changed: true };
  });
}

export async function guestUsageToday(now = Date.now()): Promise<{ tokens: number; reserved: number; senders: number }> {
  const day = utcDay(now);
  const state = await store.read();
  return {
    tokens: state.usage.day === day ? state.usage.tokens : 0,
    reserved: state.usage.day === day ? state.usage.reserved : 0,
    senders: Object.values(state.senders).filter((record) => record.day === day).length,
  };
}

export function guestLimitMessage(reason: "sender-cap" | "budget", assistantName: string): string {
  return reason === "sender-cap"
    ? `You've reached today's message limit with ${assistantName}. Try again tomorrow.`
    : `${assistantName} is resting for the day. Try again tomorrow.`;
}

export function guestTooLongMessage(maxChars: number): string {
  return `That's too long for me. Keep it under ${maxChars.toLocaleString("en-GB")} characters.`;
}

/** The one line an unknown sender sees before their first reply. */
export function firstContactDisclosure(assistantName: string, ownerName: string): string {
  return `Hi, I'm ${assistantName}, ${ownerName}'s assistant. I can show when ${ownerName} is free and pass on a meeting request. I can't share anything else from their accounts. Text me if you need to cancel a booking.`;
}
