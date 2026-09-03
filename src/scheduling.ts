import { randomInt, randomUUID } from "node:crypto";
import type { Message } from "spectrum-ts";
import { busyConflict, calendarZones, eventBounds, type CalendarEventData, type CalendarPort } from "./capabilities/calendar.js";
import { replyTargetText } from "./message-pipeline.js";
import { ownerSpaceIds } from "./owners.js";
import { startPoller } from "./poller.js";
import { minutesOfDay, type SchedulingSettings } from "./scheduling-settings.js";
import { JsonFileStore } from "./state.js";
import { sanitiseText } from "./tools.js";

export type RequestStatus = "pending" | "approving" | "booked" | "cancelling" | "declined" | "expired" | "cancelled" | "failed";

/** A transition older than this was interrupted by a crash or restart and is recovered by the poller. */
export const STALE_TRANSITION_MS = 5 * 60_000;

/** One guest's request to meet the owner. Approval and expiry state lives here, never in chat memory. */
export interface SchedulingRequest {
  code: string;
  guestSenderId: string;
  guestSpaceId: string;
  guestName: string;
  purpose: string;
  email: string;
  durationMinutes: number;
  startIso: string;
  endIso: string;
  guestTimezone: string;
  status: RequestStatus;
  createdAt: string;
  /** When the current approving/cancelling transition began. */
  transitionAt?: string;
  resolvedAt?: string;
  eventId?: string;
  meetLink?: string;
  /** The verified outcome both people were told. */
  outcome?: string;
}

interface RequestsState {
  version: 1;
  requests: SchedulingRequest[];
}

export const requestStore = new JsonFileStore<RequestsState>(
  "scheduling-requests.json",
  () => ({ version: 1, requests: [] }),
  (value) => {
    const record = value && typeof value === "object" ? value as Partial<RequestsState> : {};
    return {
      version: 1,
      requests: Array.isArray(record.requests)
        ? record.requests.filter((request): request is SchedulingRequest => Boolean(request && typeof request === "object" && typeof request.code === "string"))
        : [],
    };
  },
);

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const REQUEST_CODE = /\bPK-([A-Z0-9]{4})\b/i;

export function generateRequestCode(): string {
  let suffix = "";
  for (let index = 0; index < 4; index += 1) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `PK-${suffix}`;
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Range {
  startMs: number;
  endMs: number;
}

function zonedParts(ms: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? ""),
  };
}

/** The instant of a wall-clock time in a timezone, correct across daylight-saving changes. */
export function zonedTimestamp(date: string, minutesIntoDay: number, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0) + minutesIntoDay * 60_000;
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timezone);
    const [py, pm, pd] = parts.date.split("-").map(Number) as [number, number, number];
    const represented = Date.UTC(py, pm - 1, pd, parts.hour, parts.minute, parts.second);
    candidate += desired - represented;
  }
  return candidate;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The owner's bookable window on one owner-local date, or undefined when that day is closed. */
export function bookableRange(date: string, settings: SchedulingSettings, ownerTimezone: string): Range | undefined {
  const noon = zonedTimestamp(date, 12 * 60, ownerTimezone);
  const weekday = zonedParts(noon, ownerTimezone).weekday;
  if (!settings.bookableDays.includes(weekday >= 0 ? weekday : new Date(noon).getUTCDay())) return undefined;
  return {
    startMs: zonedTimestamp(date, minutesOfDay(settings.bookableStart), ownerTimezone),
    endMs: zonedTimestamp(date, minutesOfDay(settings.bookableEnd), ownerTimezone),
  };
}

/** Free windows inside `range`, avoiding busy blocks padded by the buffer, each at least one meeting long. */
export function freeWindows(input: {
  range: Range;
  busy: Range[];
  durationMs: number;
  bufferMs: number;
  earliestMs: number;
  maxWindows: number;
}): Range[] {
  const padded = input.busy
    .map((block) => ({ startMs: block.startMs - input.bufferMs, endMs: block.endMs + input.bufferMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const windows: Range[] = [];
  let cursor = Math.max(input.range.startMs, input.earliestMs);
  for (const block of padded) {
    if (block.endMs <= cursor) continue;
    if (block.startMs >= input.range.endMs) break;
    if (block.startMs - cursor >= input.durationMs) windows.push({ startMs: cursor, endMs: block.startMs });
    cursor = Math.max(cursor, block.endMs);
  }
  if (input.range.endMs - cursor >= input.durationMs) windows.push({ startMs: cursor, endMs: input.range.endMs });
  return windows.slice(0, input.maxWindows);
}

export function formatInZone(ms: number, timezone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...options }).format(new Date(ms));
}

export function formatWindow(window: Range, timezone: string): string {
  const time = (ms: number) => formatInZone(ms, timezone, { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?(am|pm)/i, " $1");
  return `${time(window.startMs)} to ${time(window.endMs)}`;
}

export function formatMoment(ms: number, timezone: string): string {
  return `${formatInZone(ms, timezone, { weekday: "short", day: "numeric", month: "short" })} ${formatInZone(ms, timezone, { hour: "numeric", minute: "2-digit", hour12: true })} ${timezone}`;
}

function busyBlocks(events: CalendarEventData[], zones: { timezone: string; allDayTimezone: string }): Range[] {
  const blocks: Range[] = [];
  for (const event of events) {
    if (event.status === "cancelled" || event.transparency === "transparent") continue;
    const bounds = eventBounds(event, zones);
    if (bounds) blocks.push(bounds);
  }
  return blocks;
}

export interface SchedulingServiceDeps {
  settings: { timezone: string; ownerName: string; assistantName: string; scheduling: SchedulingSettings };
  calendar: CalendarPort;
  /** Deliver text to an iMessage space by id. */
  send(spaceId: string, text: string): Promise<void>;
  ownerSpaces?(): Promise<string[]>;
  now?(): number;
}

export interface AvailabilityQuery {
  /** Calendar date in the guest's timezone. */
  date: string;
  durationMinutes: number;
  guestTimezone: string;
}

export interface SubmitInput {
  guestSenderId: string;
  guestSpaceId: string;
  guestName: string;
  purpose: string;
  email: string;
  startIso: string;
  durationMinutes: number;
  guestTimezone: string;
}

function eventTimeMs(value: unknown): number | undefined {
  const time = value && typeof value === "object" ? value as { dateTime?: string | null; date?: string | null } : undefined;
  const text = time?.dateTime ?? time?.date;
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Everything the read-back event must match before a booking is reported as done. */
export function bookingMismatches(event: CalendarEventData, request: Pick<SchedulingRequest, "startIso" | "endIso" | "email">): string[] {
  const mismatches: string[] = [];
  if (eventTimeMs(event.start) !== Date.parse(request.startIso)) mismatches.push("start time");
  if (eventTimeMs(event.end) !== Date.parse(request.endIso)) mismatches.push("end time");
  const attendees = Array.isArray(event.attendees) ? event.attendees as Array<{ email?: string | null }> : [];
  if (!attendees.some((attendee) => attendee?.email?.toLowerCase() === request.email.toLowerCase())) mismatches.push("guest attendee");
  if (event.status === "cancelled") mismatches.push("status");
  return mismatches;
}

type ClaimResult = { claimed: true; request: SchedulingRequest } | { claimed: false; request?: SchedulingRequest };

export function createSchedulingService(deps: SchedulingServiceDeps) {
  const { scheduling, timezone: ownerTimezone, ownerName, assistantName } = deps.settings;
  const now = deps.now ?? (() => Date.now());
  const ownerSpaces = deps.ownerSpaces ?? ownerSpaceIds;

  function validateDuration(minutes: number): number {
    if (!scheduling.allowedDurations.includes(minutes)) {
      throw new Error(`Meeting length must be one of ${scheduling.allowedDurations.join(", ")} minutes.`);
    }
    return minutes;
  }

  function validateTimezone(value: string): string {
    if (!isValidTimezone(value)) throw new Error(`Unknown timezone: ${value}. Ask the guest for a city or IANA timezone.`);
    return value;
  }

  async function windowsForRange(range: Range, durationMinutes: number): Promise<Range[]> {
    const zones = await calendarZones(deps.calendar, ownerTimezone);
    const firstDate = zonedParts(range.startMs, ownerTimezone).date;
    const lastDate = zonedParts(range.endMs - 1, ownerTimezone).date;
    const bookable: Range[] = [];
    for (let date = firstDate; date <= lastDate; date = shiftDate(date, 1)) {
      const day = bookableRange(date, scheduling, ownerTimezone);
      if (!day) continue;
      const clipped = { startMs: Math.max(day.startMs, range.startMs), endMs: Math.min(day.endMs, range.endMs) };
      if (clipped.endMs > clipped.startMs) bookable.push(clipped);
    }
    if (bookable.length === 0) return [];
    const bufferMs = scheduling.bufferMinutes * 60_000;
    const events = await deps.calendar.listEvents({
      timeMin: new Date(range.startMs - bufferMs - 24 * 60 * 60_000).toISOString(),
      timeMax: new Date(range.endMs + bufferMs + 24 * 60 * 60_000).toISOString(),
    });
    const busy = busyBlocks(events, zones);
    const earliestMs = now() + scheduling.minimumNoticeHours * 60 * 60_000;
    const windows: Range[] = [];
    for (const piece of bookable) {
      windows.push(...freeWindows({
        range: piece, busy, durationMs: durationMinutes * 60_000, bufferMs, earliestMs,
        maxWindows: scheduling.maxWindows - windows.length,
      }));
      if (windows.length >= scheduling.maxWindows) break;
    }
    return windows.slice(0, scheduling.maxWindows);
  }

  async function availability(query: AvailabilityQuery) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) throw new Error("Date must be YYYY-MM-DD.");
    const guestTimezone = validateTimezone(query.guestTimezone);
    const durationMinutes = validateDuration(query.durationMinutes);
    const dayStart = zonedTimestamp(query.date, 0, guestTimezone);
    const dayEnd = zonedTimestamp(shiftDate(query.date, 1), 0, guestTimezone);
    const latest = now() + scheduling.lookaheadDays * 24 * 60 * 60_000;
    if (dayStart > latest) {
      return { windows: [], note: `${ownerName} only takes bookings up to ${scheduling.lookaheadDays} days ahead.` };
    }
    if (dayEnd <= now()) return { windows: [], note: "That day has already passed." };
    const windows = await windowsForRange({ startMs: dayStart, endMs: Math.min(dayEnd, latest) }, durationMinutes);
    return {
      windows: windows.map((window) => ({
        start: new Date(window.startMs).toISOString(),
        end: new Date(window.endMs).toISOString(),
        label: `${formatWindow(window, guestTimezone)} ${guestTimezone}`,
      })),
      note: windows.length ? `Times shown in ${guestTimezone}. ${ownerName} has not confirmed anything yet.` : `${ownerName} has no bookable time that day.`,
    };
  }

  async function pendingFor(guestSenderId: string): Promise<SchedulingRequest[]> {
    return (await requestStore.read()).requests.filter((request) => request.guestSenderId === guestSenderId && request.status === "pending");
  }

  async function updateRequest(code: string, patch: Partial<SchedulingRequest>): Promise<SchedulingRequest | undefined> {
    return requestStore.update<SchedulingRequest | undefined>((state) => {
      const request = state.requests.find((candidate) => candidate.code === code);
      if (!request) return { result: undefined, changed: false };
      Object.assign(request, patch);
      return { result: request, changed: true };
    });
  }

  /**
   * Move one request from `from` to `to` in a single store transaction, so two
   * chats acting on the same request at once cannot both proceed.
   */
  async function claimTransition(code: string, from: RequestStatus, to: RequestStatus): Promise<ClaimResult> {
    return requestStore.update<ClaimResult>((state) => {
      const request = state.requests.find((candidate) => candidate.code === code);
      if (!request || request.status !== from) return { result: { claimed: false, request: request ? structuredClone(request) : undefined }, changed: false };
      request.status = to;
      request.transitionAt = new Date(now()).toISOString();
      return { result: { claimed: true, request: structuredClone(request) }, changed: true };
    });
  }

  async function notifyGuest(request: SchedulingRequest, text: string): Promise<void> {
    await deps.send(request.guestSpaceId, text).catch((error) => {
      console.error("Unable to notify the guest:", { code: request.code, message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Deliver text to every owner chat and report how many actually received it. */
  async function notifyOwners(text: string): Promise<number> {
    let delivered = 0;
    for (const spaceId of await ownerSpaces()) {
      try {
        await deps.send(spaceId, text);
        delivered += 1;
      } catch (error) {
        console.error("Unable to deliver to an owner chat:", { spaceId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return delivered;
  }

  function expiryMs(request: SchedulingRequest): number {
    return Date.parse(request.createdAt) + scheduling.requestExpiryHours * 60 * 60_000;
  }

  async function submitRequest(input: SubmitInput) {
    const guestTimezone = validateTimezone(input.guestTimezone);
    const durationMinutes = validateDuration(input.durationMinutes);
    const startMs = Date.parse(input.startIso);
    if (!Number.isFinite(startMs)) throw new Error("Start must be an ISO 8601 date-time with a UTC offset.");
    const endMs = startMs + durationMinutes * 60_000;
    const email = input.email.trim();
    if (!EMAIL_PATTERN.test(email)) throw new Error("A valid email address for the invitation is required.");
    const guestName = sanitiseText(input.guestName, 60);
    const purpose = sanitiseText(input.purpose, 200);
    if (!guestName) throw new Error("The guest's name is required.");
    if (!purpose) throw new Error("A short purpose for the meeting is required.");
    if ((await pendingFor(input.guestSenderId)).length >= scheduling.maxPendingPerGuest) {
      throw new Error(`You already have a request waiting for ${ownerName}. Wait for that answer, or cancel it first.`);
    }
    const windows = await windowsForRange({ startMs, endMs }, durationMinutes);
    const fits = windows.some((window) => window.startMs <= startMs && endMs <= window.endMs);
    if (!fits) throw new Error("That time is not bookable any more. Check availability again and pick another window.");

    const request: SchedulingRequest = {
      code: generateRequestCode(),
      guestSenderId: input.guestSenderId,
      guestSpaceId: input.guestSpaceId,
      guestName,
      purpose,
      email,
      durationMinutes,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      guestTimezone,
      status: "pending",
      createdAt: new Date(now()).toISOString(),
    };
    await requestStore.update((state) => {
      state.requests.push(request);
      return { result: undefined, changed: true };
    });

    const ownerText = [
      `📅 Request ${request.code} from ${guestName}. "${purpose}".`,
      `${durationMinutes} min, ${formatMoment(startMs, ownerTimezone)} (${formatMoment(startMs, guestTimezone)} for them).`,
      `Email ${email}, unverified. Reply yes or no to this message.`,
    ].join("\n");
    const delivered = await notifyOwners(ownerText);
    if (delivered === 0) {
      // Never tell a guest something was sent when nobody received it.
      const outcome = `Could not reach ${ownerName}. Nothing was sent.`;
      console.error("A scheduling request could not reach any owner chat.", { code: request.code });
      await updateRequest(request.code, { status: "failed", resolvedAt: new Date(now()).toISOString(), outcome });
      return {
        request: { ...request, status: "failed" as const, outcome },
        delivered: false,
        guestText: `I couldn't reach ${ownerName} to pass this on, so nothing was sent. Try again later.`,
      };
    }
    return {
      request,
      delivered: true,
      guestText: `Sent to ${ownerName}: ${formatMoment(startMs, guestTimezone)}, ${durationMinutes} min, "${purpose}", invite to ${email}. The slot isn't held until they approve. Request ${request.code}.`,
    };
  }

  /** Approve a pending request: claim it, recheck the slot, create the event, verify every field, then tell both people. */
  async function approve(code: string): Promise<string> {
    const existing = (await requestStore.read()).requests.find((candidate) => candidate.code === code);
    if (!existing) return `I don't have a request ${code}.`;
    if (existing.status === "pending" && expiryMs(existing) <= now()) {
      const expired = await expire(existing);
      return `Request ${code} expired before you replied. ${expired.guestName} has been told.`;
    }
    const claim = await claimTransition(code, "pending", "approving");
    if (!claim.claimed) {
      const status = claim.request?.status ?? "missing";
      return status === "approving" ? `Request ${code} is being booked right now.` : `Request ${code} is already ${status}.`;
    }
    const request = claim.request;
    const startMs = Date.parse(request.startIso);
    const endMs = Date.parse(request.endIso);
    const zones = await calendarZones(deps.calendar, ownerTimezone);
    const conflict = await busyConflict(deps.calendar, [{ startMs, endMs }], new Set(), zones);
    if (conflict) {
      const outcome = "The slot became unavailable, so I did not create anything.";
      await updateRequest(code, { status: "failed", resolvedAt: new Date(now()).toISOString(), outcome });
      await notifyGuest(request, `${outcome} Ask me for ${ownerName}'s availability again to pick another time.`);
      return `${outcome} ${request.guestName} has been told.`;
    }
    let created: CalendarEventData;
    try {
      created = await deps.calendar.insertEvent({
        summary: `Call with ${request.guestName}`,
        description: `${request.purpose}\n\nRequested through ${assistantName}. Guest email (unverified): ${request.email}.`,
        start: { dateTime: request.startIso, timeZone: ownerTimezone },
        end: { dateTime: request.endIso, timeZone: ownerTimezone },
        attendees: [{ email: request.email }],
        ...(scheduling.meetLink ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
      }, "all", { conferenceDataVersion: scheduling.meetLink ? 1 : 0 });
    } catch (error) {
      const outcome = "Google rejected the request. Nothing was changed.";
      console.error("Scheduling approval failed:", { code, message: error instanceof Error ? error.message : String(error) });
      await updateRequest(code, { status: "failed", resolvedAt: new Date(now()).toISOString(), outcome });
      await notifyGuest(request, `${outcome} ${ownerName} will follow up.`);
      return `${outcome} ${request.guestName} has been told.`;
    }
    const verified = created.id ? await deps.calendar.getEvent(created.id) : undefined;
    if (!verified) {
      const outcome = "Google accepted the event but I could not read it back, so I am not treating it as booked.";
      await updateRequest(code, { status: "failed", resolvedAt: new Date(now()).toISOString(), outcome, eventId: created.id ?? undefined });
      await notifyGuest(request, `Something went wrong while booking. ${ownerName} will follow up.`);
      return `${outcome} Check your calendar for "Call with ${request.guestName}".`;
    }
    const mismatches = bookingMismatches(verified, request);
    if (mismatches.length) {
      const outcome = `Google created the event but it does not match the request (${mismatches.join(", ")}). Check "Call with ${request.guestName}" in your calendar.`;
      await updateRequest(code, { status: "failed", resolvedAt: new Date(now()).toISOString(), outcome, eventId: verified.id ?? undefined });
      await notifyGuest(request, `Something went wrong while booking. ${ownerName} will follow up.`);
      return outcome;
    }
    const meetLink = meetLinkOf(verified);
    const linkNote = scheduling.meetLink && !meetLink ? " Google did not attach a Meet link; add one from the calendar." : meetLink ? " Meet link is on the event." : "";
    const outcome = `Booked and invitation sent to ${request.email}.${linkNote}`;
    await updateRequest(code, { status: "booked", resolvedAt: new Date(now()).toISOString(), outcome, eventId: verified.id ?? undefined, meetLink });
    await notifyGuest(request, `Confirmed for ${formatMoment(startMs, request.guestTimezone)}. Invite sent to ${request.email}.${meetLink ? ` Meet link: ${meetLink}` : ""} Text me if you need to cancel.`);
    return outcome;
  }

  async function decline(code: string): Promise<string> {
    const claim = await claimTransition(code, "pending", "declined");
    if (!claim.claimed) return claim.request ? `Request ${code} is already ${claim.request.status}.` : `I don't have a request ${code}.`;
    const outcome = `${ownerName} can't make that time.`;
    await updateRequest(code, { resolvedAt: new Date(now()).toISOString(), outcome });
    await notifyGuest(claim.request, `${outcome} Ask me for their availability again if you'd like another time.`);
    return `Declined. ${claim.request.guestName} has been told. Nothing was created.`;
  }

  async function expire(request: SchedulingRequest): Promise<SchedulingRequest> {
    const claim = await claimTransition(request.code, "pending", "expired");
    if (!claim.claimed) return claim.request ?? request;
    const outcome = `Your request expired before ${ownerName} approved it.`;
    await updateRequest(request.code, { resolvedAt: new Date(now()).toISOString(), outcome });
    await notifyGuest(request, `${outcome} Ask me for availability again to send a new one.`);
    return { ...claim.request, outcome };
  }

  async function expirePending(): Promise<void> {
    const due = (await requestStore.read()).requests.filter((request) => request.status === "pending" && expiryMs(request) <= now());
    for (const request of due) await expire(request);
  }

  /** A transition left behind by a crash: settle it from what the calendar actually holds. */
  async function recoverStale(): Promise<void> {
    const stale = (await requestStore.read()).requests.filter((request) =>
      (request.status === "approving" || request.status === "cancelling")
      && now() - Date.parse(request.transitionAt ?? request.createdAt) > STALE_TRANSITION_MS);
    for (const request of stale) {
      if (request.status === "approving") {
        const outcome = `Approval was interrupted by a restart. Check your calendar for "Call with ${request.guestName}" before approving again.`;
        await updateRequest(request.code, { status: "failed", resolvedAt: new Date(now()).toISOString(), outcome });
        await notifyOwners(`Request ${request.code}: ${outcome}`);
        await notifyGuest(request, `Something went wrong while booking. ${ownerName} will follow up.`);
        continue;
      }
      const remaining = request.eventId ? await deps.calendar.getEvent(request.eventId) : undefined;
      if (remaining && remaining.status !== "cancelled") {
        await updateRequest(request.code, { status: "booked", transitionAt: undefined });
      } else {
        await updateRequest(request.code, { status: "cancelled", resolvedAt: new Date(now()).toISOString(), outcome: "Cancelled. The invitation has been withdrawn." });
      }
    }
  }

  function startExpiryPoller(intervalMs = 60_000): () => void {
    return startPoller("Scheduling expiry", intervalMs, async () => {
      await recoverStale();
      await expirePending();
    });
  }

  /** Cancel the guest's own booking: claim it, remove the event, verify it is gone, and tell the owner. */
  async function cancelGuestBooking(guestSenderId: string, code?: string): Promise<string> {
    const candidates = (await requestStore.read()).requests
      .filter((request) => request.guestSenderId === guestSenderId && (request.status === "booked" || request.status === "pending"))
      .filter((request) => !code || request.code.toUpperCase() === code.toUpperCase())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const request = candidates[0];
    if (!request) return code ? `I don't have an active request ${code} for you.` : "You have no booking or pending request to cancel.";
    if (request.status === "pending") {
      const claim = await claimTransition(request.code, "pending", "cancelled");
      if (!claim.claimed) return `Request ${request.code} is already ${claim.request?.status ?? "gone"}.`;
      await updateRequest(request.code, { resolvedAt: new Date(now()).toISOString(), outcome: "Cancelled by the guest before approval." });
      await notifyOwners(`Request ${request.code} from ${request.guestName} was withdrawn.`);
      return `Cancelled request ${request.code}. ${ownerName} has been told.`;
    }
    if (!request.eventId) return "That booking has no calendar event to remove. Contact the owner directly.";
    const claim = await claimTransition(request.code, "booked", "cancelling");
    if (!claim.claimed) return `Booking ${request.code} is already ${claim.request?.status ?? "gone"}.`;
    try {
      await deps.calendar.deleteEvent(request.eventId, "all");
    } catch (error) {
      console.error("Guest cancellation failed:", { code: request.code, message: error instanceof Error ? error.message : String(error) });
      await updateRequest(request.code, { status: "booked", transitionAt: undefined });
      return "Google rejected the cancellation. Nothing was changed. Try again in a moment.";
    }
    const remaining = await deps.calendar.getEvent(request.eventId);
    if (remaining && remaining.status !== "cancelled") {
      await updateRequest(request.code, { status: "booked", transitionAt: undefined });
      return "I asked Google to cancel but the event is still there. Nothing else was changed. Try again in a moment.";
    }
    const outcome = "Cancelled. The invitation has been withdrawn.";
    await updateRequest(request.code, { status: "cancelled", resolvedAt: new Date(now()).toISOString(), outcome });
    const when = formatMoment(Date.parse(request.startIso), ownerTimezone);
    await notifyOwners(`${request.guestName} cancelled ${when} (${request.code}). The event has been removed.`);
    return `${outcome} ${ownerName} has been told.`;
  }

  async function requestsFor(guestSenderId: string): Promise<SchedulingRequest[]> {
    return (await requestStore.read()).requests.filter((request) => request.guestSenderId === guestSenderId);
  }

  /**
   * An owner's yes or no resolves the request named by the message they
   * replied to, or by a code in their text. A bare yes with requests pending
   * asks which one instead of guessing.
   */
  async function resolveOwnerReply(input: { message: Message; texts: readonly string[]; spaceId: string; senderId: string }): Promise<string | undefined> {
    const text = input.texts.join(" ").trim();
    const decision = decisionOf(text);
    if (!decision) return undefined;
    const target = replyTargetText(input.message);
    const code = (target?.match(REQUEST_CODE) ?? text.match(REQUEST_CODE))?.[0]?.toUpperCase();
    if (code) {
      const known = (await requestStore.read()).requests.some((request) => request.code === code);
      if (!known) return undefined;
      return decision === "yes" ? approve(code) : decline(code);
    }
    const pending = (await requestStore.read()).requests.filter((request) => request.status === "pending");
    if (pending.length === 0) return undefined;
    return `Which request? Reply to the request message, or include its code: ${pending.map((request) => `${request.code} (${request.guestName})`).join(", ")}.`;
  }

  return { availability, submitRequest, approve, decline, cancelGuestBooking, requestsFor, resolveOwnerReply, expirePending, recoverStale, startExpiryPoller };
}

export type SchedulingService = ReturnType<typeof createSchedulingService>;

function decisionOf(text: string): "yes" | "no" | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (/^(yes|yep|yeah|approve|approved|book it|go ahead|confirm|ok(ay)?)(\s+pk-[a-z0-9]{4})?$/i.test(normalized) || /^pk-[a-z0-9]{4}\s+(yes|approve|ok)$/i.test(normalized)) return "yes";
  if (/^(no|nope|decline|declined|reject|can't|cannot|busy)(\s+pk-[a-z0-9]{4})?$/i.test(normalized) || /^pk-[a-z0-9]{4}\s+(no|decline)$/i.test(normalized)) return "no";
  return undefined;
}

function meetLinkOf(event: CalendarEventData): string | undefined {
  const direct = (event as { hangoutLink?: string | null }).hangoutLink;
  if (direct) return direct;
  const conference = (event as { conferenceData?: { entryPoints?: Array<{ uri?: string | null; entryPointType?: string | null }> | null } | null }).conferenceData;
  return conference?.entryPoints?.find((point) => point.entryPointType === "video")?.uri ?? conference?.entryPoints?.[0]?.uri ?? undefined;
}
