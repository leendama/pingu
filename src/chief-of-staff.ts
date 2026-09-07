import type { CalendarPort } from "./capabilities/calendar.js";
import type { GmailMessage, GmailPort } from "./capabilities/gmail.js";
import { localDate } from "./daily-review.js";
import { ProposalLedger, type Proposal, type PreferenceRule } from "./proposals.js";
import { zonedTimestamp } from "./scheduling.js";

export interface EmailReview {
  actionable: boolean;
  interrupt: boolean;
  summary: string;
  rationale: string;
  confidence: number;
  draftBody?: string;
}

export interface EmailReviewContext {
  message: GmailMessage;
  thread: GmailMessage[];
  sentContext: GmailMessage[];
}

export interface CalendarReview {
  summary: string;
  detail: string;
  rationale: string;
  confidence: number;
  moves: Array<{ eventId: string; newStart: string; newEnd: string; sequenceGroup?: string | null }>;
}

export interface ChiefOfStaffDeps {
  gmail: GmailPort;
  calendar: CalendarPort;
  ledger: ProposalLedger;
  timezone: string;
  ownerSpaces(): Promise<string[]>;
  deliver(spaceId: string, text: string): Promise<void>;
  reviewEmail(context: EmailReviewContext, preferences: PreferenceRule[]): Promise<EmailReview>;
  planning: { workdayStart: string; workdayEnd: string; bufferMinutes: number; minimumNoticeHours: number };
  reviewCalendar?(events: unknown[], preferences: PreferenceRule[], date: string, planning: ChiefOfStaffDeps["planning"]): Promise<CalendarReview | undefined>;
  learnHistory?(input: { inbox: unknown[]; sent: unknown[]; calendar: unknown[] }): Promise<Array<Omit<PreferenceRule, "updatedAt">>>;
  now?: () => Date;
}

const HISTORY_MAIL_LIMIT = 20;
const HISTORY_CALENDAR_LIMIT = 200;

function headerAddress(value?: string | null): string | undefined {
  if (!value) return undefined;
  const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = value.match(/\b[^\s<>,;]+@[^\s<>,;]+\b/);
  return (bracketed?.[1] ?? bare?.[0])?.trim();
}

function sensitiveEmail(message: GmailMessage): boolean {
  const text = `${message.subject ?? ""}\n${message.snippet ?? ""}\n${message.body.slice(0, 4_000)}`.toLowerCase();
  return /\b(medical|diagnosis|health|bank|account number|tax|legal|lawyer|password|security code|salary|payroll)\b/.test(text);
}

function deterministicallyUrgent(message: GmailMessage, now: Date, timezone: string): boolean {
  const text = `${message.subject ?? ""}\n${message.snippet ?? ""}\n${message.body.slice(0, 2_000)}`.toLowerCase();
  const today = localDate(now.getTime(), timezone);
  return /\b(urgent|action required|security alert|password reset|cancelled|canceled|rescheduled|interview|booking change|due today|deadline today)\b/.test(text)
    || text.includes(today);
}

function formatProposal(proposal: Proposal, ordinal: number): string {
  const boundary = proposal.kind === "email_draft"
    ? "Approve to create this Gmail draft. Pingu will not send it."
    : proposal.kind === "calendar_move"
      ? `Approve to apply ${(proposal.payload as { moves?: unknown[] }).moves?.length ?? 0} calendar change(s).`
      : "Approve to start this one-time history import.";
  const showDetail = proposal.kind === "history_import" || (proposal.kind === "calendar_move" && !proposal.summary.startsWith("Sensitive"));
  return [`${ordinal}. ${proposal.summary}`, proposal.evidence.rationale, ...(showDetail ? [proposal.detail] : []), boundary].join("\n");
}

function calendarEvidence(events: unknown[]): unknown[] {
  return events.map((value) => {
    const event = value as Record<string, unknown>;
    return {
      id: event.id, summary: event.summary, start: event.start, end: event.end,
      transparency: event.transparency, colorId: event.colorId, recurringEventId: event.recurringEventId,
      organizerSelf: (event.organizer as { self?: boolean } | undefined)?.self,
      attendeeCount: Array.isArray(event.attendees) ? event.attendees.filter((attendee) => !(attendee as { self?: boolean })?.self).length : 0,
      etag: event.etag, updated: event.updated,
    };
  });
}

async function historyMailEvidence(gmail: GmailPort, messages: Array<{ id?: string | null }>, limit = HISTORY_MAIL_LIMIT): Promise<unknown[]> {
  const selected = messages.filter((message): message is { id: string } => Boolean(message.id)).slice(0, limit);
  const full = await Promise.all(selected.map((message) => gmail.readMessage(message.id)));
  return full.map((message) => ({
    id: message.id, threadId: message.threadId, from: message.from, to: message.to,
    subject: message.subject, date: message.date, labelIds: message.labelIds,
    body: message.body.slice(0, 2_500), truncated: message.truncated || message.body.length > 2_500,
  }));
}

function localMinute(timestamp: number, timezone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function configuredMinute(value: string): number {
  if (value === "24:00") return 1_440;
  const [hour, minute] = value.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
}

function conciseEventTime(value: unknown, timezone: string): string {
  if (!value || typeof value !== "object") return "unknown";
  const eventTime = value as { dateTime?: string; date?: string };
  if (eventTime.date) return eventTime.date;
  const timestamp = Date.parse(eventTime.dateTime ?? "");
  if (!Number.isFinite(timestamp)) return eventTime.dateTime ?? "unknown";
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
}

function conciseTimestamp(value: string, timezone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
}

export function formatBriefing(proposals: Proposal[]): string {
  if (proposals.length === 0) return "Nothing worth your attention right now.";
  return ["Quick chief-of-staff check:", ...proposals.map((proposal, index) => formatProposal(proposal, index + 1)), "Reply: approve 1, edit 1, show 1, why 1, not now Friday 1, or ignore 1."].join("\n\n");
}

export function createChiefOfStaff(deps: ChiefOfStaffDeps) {
  const now = deps.now ?? (() => new Date());

  async function deliverBriefing(spaceId: string, proposals: Proposal[], reviewKey: string): Promise<void> {
    const briefing = deps.ledger.bindBriefing(spaceId, proposals.map((proposal) => proposal.id), now(), reviewKey);
    if (briefing.status === "delivered") return;
    const boundProposals = deps.ledger.proposalsById(briefing.proposalIds);
    const uncertainRetry = briefing.status === "delivery_unknown" || briefing.attempts > 0;
    deps.ledger.markBriefingAttempt(reviewKey);
    await deps.deliver(spaceId, `${uncertainRetry ? "Retrying because the last delivery was uncertain.\n\n" : ""}${formatBriefing(boundProposals)}`);
    deps.ledger.markBriefingDelivered(reviewKey, now());
  }

  function interruptProposals(ownerSpaceId: string, proposal: Proposal): Proposal[] {
    const open = deps.ledger.listOpen(ownerSpaceId, now(), 5, deps.timezone);
    return [proposal, ...open.filter((item) => item.id !== proposal.id)].slice(0, 5);
  }

  async function reviewEmailCandidate(messageId: string, options: { interrupt: boolean }): Promise<void> {
    const ownerSpaces = await deps.ownerSpaces();
    if (ownerSpaces.length === 0) throw new Error("Chief-of-staff email review is waiting for a verified owner chat.");
    const message = await deps.gmail.readMessage(messageId);
    if (message.labelIds && !message.labelIds.includes("INBOX")) return;
    const sourceId = message.id ?? messageId;
    const reviewedKey = `chief-of-staff:email-reviewed:${sourceId}`;
    if (deps.ledger.getMetadata(reviewedKey)) return;
    const recipient = headerAddress(message.from);
    if (!recipient) {
      deps.ledger.setMetadata(reviewedKey, now().toISOString());
      return;
    }
    const sourceKey = `gmail:${message.threadId ?? message.id ?? messageId}`;
    const existing = ownerSpaces.map((ownerSpaceId) => ({ ownerSpaceId, proposal: deps.ledger.findSourceVersion(ownerSpaceId, "email_draft", sourceKey, sourceId) }));
    if (existing.every(({ proposal }) => Boolean(proposal))) {
      if (options.interrupt) {
        for (const { ownerSpaceId, proposal } of existing) {
          if (proposal) await deliverBriefing(ownerSpaceId, interruptProposals(ownerSpaceId, proposal), `gmail:${messageId}:${ownerSpaceId}`);
        }
      }
      deps.ledger.setMetadata(reviewedKey, now().toISOString());
      return;
    }
    const thread = message.threadId && deps.gmail.readThread ? await deps.gmail.readThread(message.threadId) : [message];
    const sentMatches = await deps.gmail.searchMessages(`in:sent to:${recipient}`, 5);
    const sentContext = (await Promise.all(sentMatches.filter((item) => item.id).slice(0, 3).map((item) => deps.gmail.readMessage(item.id!))));
    const urgent = deterministicallyUrgent(message, now(), deps.timezone);
    const preferences = deps.ledger.preferences(now());
    const contactKey = `email_draft:contact:${recipient.toLowerCase()}`;
    if (!urgent && preferences.some((rule) => rule.key === `${contactKey}:ignored`)) {
      deps.ledger.setMetadata(reviewedKey, now().toISOString());
      return;
    }
    const review = await deps.reviewEmail({ message, thread: thread.slice(-20), sentContext }, preferences);
    const alwaysSurface = preferences.some((rule) => rule.key === `${contactKey}:always_surface`);
    const lowPriority = preferences.some((rule) => rule.key === `${contactKey}:not_important`);
    if (!review.actionable || !review.draftBody?.trim()) {
      if ((urgent || alwaysSurface) && options.interrupt) {
        const notice = sensitiveEmail(message)
          ? `${urgent ? "Urgent sensitive email" : "Sensitive email"} needs your review.`
          : `${urgent ? "Urgent email" : "Email to review"}: ${message.subject || "check Gmail"}`;
        for (const ownerSpaceId of ownerSpaces) await deps.deliver(ownerSpaceId, notice);
      }
      deps.ledger.setMetadata(reviewedKey, now().toISOString());
      return;
    }
    const subject = /^re:/i.test(message.subject ?? "") ? message.subject! : `Re: ${message.subject || "Your email"}`;
    for (const ownerSpaceId of ownerSpaces) {
      const isSensitive = sensitiveEmail(message);
      const proposal = deps.ledger.create({
        ownerSpaceId,
        kind: "email_draft",
        sourceKey,
        summary: isSensitive ? "Sensitive email needs your review" : review.summary,
        detail: review.draftBody,
        payload: {
          to: [recipient], cc: [], bcc: [], subject, body: review.draftBody,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          ...(message.id ? { sourceMessageId: message.id } : {}),
          ...(message.messageIdHeader ? { inReplyTo: message.messageIdHeader } : {}),
          ...(message.references || message.messageIdHeader ? { references: [message.references, message.messageIdHeader].filter(Boolean).join(" ") } : {}),
        },
        evidence: { sourceType: "gmail", sourceId, contact: recipient, category: "email-reply", ruleIds: preferences.map((rule) => rule.key).slice(0, 20), rationale: isSensitive ? "A sensitive message needs a private decision." : review.rationale, confidence: Math.max(0, Math.min(1, review.confidence)) },
        expiresAt: new Date(now().getTime() + 7 * 86_400_000).toISOString(),
      }, now());
      if (options.interrupt && (urgent || alwaysSurface || (review.interrupt && !lowPriority))) {
        await deliverBriefing(ownerSpaceId, interruptProposals(ownerSpaceId, proposal), `gmail:${messageId}:${ownerSpaceId}`);
      }
    }
    deps.ledger.setMetadata(reviewedKey, now().toISOString());
  }


  async function reviewIncomingEmail(messageId: string): Promise<void> {
    await reviewEmailCandidate(messageId, { interrupt: true });
  }

  async function runDailyReview(input: { date: string; reviewKey: string }): Promise<void> {
    const ownerSpaces = await deps.ownerSpaces();
    const pendingSpaces = ownerSpaces.filter((spaceId) => deps.ledger.briefing(`${input.reviewKey}:${spaceId}`)?.status !== "delivered");
    if (pendingSpaces.length === 0) return;
    const start = new Date(zonedTimestamp(input.date, 0, deps.timezone));
    const [year, month, day] = input.date.split("-").map(Number) as [number, number, number];
    const nextDate = new Date(Date.UTC(year, month - 1, day));
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const end = new Date(zonedTimestamp(nextDate.toISOString().slice(0, 10), 0, deps.timezone));
    const events = await deps.calendar.listEvents({ timeMin: start.toISOString(), timeMax: end.toISOString() });
    if (events.length > 100) throw new Error("Today's calendar has too many events for a safe complete reshuffle.");
    const recent = await deps.gmail.searchMessages("in:inbox is:unread newer_than:7d", 20);
    for (const message of recent) if (message.id) await reviewEmailCandidate(message.id, { interrupt: false });
    for (const ownerSpaceId of pendingSpaces) {
      if (deps.reviewCalendar) {
        const plan = await deps.reviewCalendar(calendarEvidence(events), deps.ledger.preferences(now()), input.date, deps.planning);
        if (plan?.moves.length) {
          const snapshots = new Map(events.filter((event): event is typeof event & { id: string } => Boolean((event as { id?: string }).id)).map((event) => [(event as { id: string }).id, event as { etag?: string; updated?: string; summary?: string; start?: unknown; end?: unknown; recurringEventId?: string; organizer?: { self?: boolean }; attendees?: Array<{ self?: boolean }> }]));
          for (const move of plan.moves) {
            const source = snapshots.get(move.eventId);
            if (!source) throw new Error(`The calendar planner used unknown event ${move.eventId}.`);
            if (source.recurringEventId || source.organizer?.self === false || source.attendees?.some((attendee) => !attendee.self)) throw new Error(`The calendar planner tried to move a recurring, externally organised, or attended event ${move.eventId}.`);
            if (/\b(meeting|appointment|flight|train|travel|doctor|therapy|sleep|protected|do not move)\b/i.test(source.summary ?? "")) throw new Error(`The calendar planner tried to move protected event ${move.eventId}.`);
            const startMs = Date.parse(move.newStart);
            const endMs = Date.parse(move.newEnd);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || localDate(startMs, deps.timezone) !== input.date || localDate(endMs - 1, deps.timezone) !== input.date) throw new Error(`The calendar planner moved ${move.eventId} outside the reviewed day.`);
            if (startMs < now().getTime() + deps.planning.minimumNoticeHours * 3_600_000) throw new Error(`The calendar planner moved ${move.eventId} inside the minimum-notice window.`);
            const startMinute = localMinute(startMs, deps.timezone);
            const endMinute = localMinute(endMs - 1, deps.timezone) + 1;
            if (startMinute < configuredMinute(deps.planning.workdayStart) || endMinute > configuredMinute(deps.planning.workdayEnd)) throw new Error(`The calendar planner moved ${move.eventId} outside configured working hours.`);
          }
          const exactDetail = plan.moves.map((move) => {
            const source = snapshots.get(move.eventId)!;
            return `${source.summary ?? move.eventId}: ${conciseEventTime(source.start, deps.timezone)}-${conciseEventTime(source.end, deps.timezone)} → ${conciseTimestamp(move.newStart, deps.timezone)}-${conciseTimestamp(move.newEnd, deps.timezone)}`;
          }).join("\n");
          const sensitivePlan = plan.moves.some((move) => /\b(medical|health|therapy|bank|legal|lawyer|salary|payroll)\b/i.test(snapshots.get(move.eventId)?.summary ?? ""));
          deps.ledger.create({
            ownerSpaceId, kind: "calendar_move", sourceKey: `calendar:${input.date}`,
            summary: sensitivePlan ? "Sensitive calendar plan needs your review" : plan.summary, detail: exactDetail,
            payload: { timezone: deps.timezone, bufferMinutes: deps.planning.bufferMinutes, moves: plan.moves.map((move) => ({ ...move, expectedEtag: snapshots.get(move.eventId)?.etag, expectedUpdated: snapshots.get(move.eventId)?.updated })) },
            evidence: { sourceType: "calendar", sourceId: input.date, category: "same-day-reshuffle", ruleIds: deps.ledger.preferences(now()).map((rule) => rule.key).slice(0, 20), rationale: sensitivePlan ? "A private scheduling conflict needs a decision." : plan.rationale, confidence: plan.confidence },
            expiresAt: end.toISOString(),
          }, now());
        }
      }
      await deliverBriefing(ownerSpaceId, deps.ledger.listOpen(ownerSpaceId, now(), 5, deps.timezone), `${input.reviewKey}:${ownerSpaceId}`);
    }
  }

  async function importHistory(proposal?: Proposal): Promise<void> {
    if (!deps.learnHistory || deps.ledger.getMetadata("chief-of-staff:history-imported")) return;
    const approved = proposal?.payload as { start?: string; end?: string } | undefined;
    const end = approved?.end ? new Date(approved.end) : now();
    const start = approved?.start ? new Date(approved.start) : new Date(end.getTime() - 180 * 86_400_000);
    const days = Math.max(1, Math.min(180, Math.ceil((end.getTime() - start.getTime()) / 86_400_000)));
    const [inbox, sent, calendar] = await Promise.all([
      deps.gmail.searchMessages(`in:inbox newer_than:${days}d`, 100),
      deps.gmail.searchMessages(`in:sent newer_than:${days}d`, 100),
      deps.calendar.listEvents({ timeMin: start.toISOString(), timeMax: end.toISOString() }),
    ]);
    for (const ownerSpaceId of await deps.ownerSpaces()) await deps.deliver(ownerSpaceId, "Importing the approved history sample now. I’ll confirm when it’s learned.");
    const rules = await deps.learnHistory({
      inbox: await historyMailEvidence(deps.gmail, inbox),
      sent: await historyMailEvidence(deps.gmail, sent),
      calendar: calendarEvidence(calendar.slice(-HISTORY_CALENDAR_LIMIT)),
    });
    const learnedAt = now();
    for (const rule of rules.slice(0, 50)) deps.ledger.recordPreference({
      ...rule,
      key: rule.key.startsWith("inferred:") ? rule.key : `inferred:${rule.key}`,
      evidenceCount: rule.evidenceCount ?? 1,
      reviewAfter: new Date(learnedAt.getTime() + 30 * 86_400_000).toISOString(),
      expiresAt: new Date(learnedAt.getTime() + 90 * 86_400_000).toISOString(),
    }, learnedAt);
    deps.ledger.setMetadata("chief-of-staff:history-imported", now().toISOString());
  }

  async function prepareHistoryImport(providerDisclosure: string): Promise<void> {
    if (!deps.learnHistory || deps.ledger.getMetadata("chief-of-staff:history-imported") || deps.ledger.getMetadata("chief-of-staff:history-previewed")) return;
    const ownerSpaces = await deps.ownerSpaces();
    if (ownerSpaces.length === 0) return;
    const end = now();
    const start = new Date(end.getTime() - 180 * 86_400_000);
    const [inbox, sent, calendar] = await Promise.all([
      deps.gmail.searchMessages("in:inbox newer_than:180d", 100),
      deps.gmail.searchMessages("in:sent newer_than:180d", 100),
      deps.calendar.listEvents({ timeMin: start.toISOString(), timeMax: end.toISOString() }),
    ]);
    const inboxCount = Math.min(inbox.filter((message) => message.id).length, HISTORY_MAIL_LIMIT);
    const sentCount = Math.min(sent.filter((message) => message.id).length, HISTORY_MAIL_LIMIT);
    const calendarCount = Math.min(calendar.length, HISTORY_CALENDAR_LIMIT);
    const detail = `Date range: ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}\nItems sent for learning: ${inboxCount} inbox, ${sentCount} sent, ${calendarCount} calendar\nProvider: ${providerDisclosure}\nOnly compact preference rules stay in Pingu's local ledger.`;
    for (const ownerSpaceId of ownerSpaces) {
      const proposal = deps.ledger.create({
        ownerSpaceId, kind: "history_import", sourceKey: "history-import:180d",
        summary: `Learn from a ${inboxCount + sentCount + calendarCount}-item history sample`, detail,
        payload: { start: start.toISOString(), end: end.toISOString(), inboxCount, sentCount, calendarCount, providerDisclosure },
        evidence: { sourceType: "local-settings", sourceId: "history-import:180d", rationale: "You enabled historical learning in setup. Approval starts the bounded import.", confidence: 1 },
        expiresAt: new Date(end.getTime() + 7 * 86_400_000).toISOString(),
      }, end);
      await deliverBriefing(ownerSpaceId, [proposal], `history-import:${ownerSpaceId}:${proposal.id}`);
    }
    deps.ledger.setMetadata("chief-of-staff:history-previewed", end.toISOString());
  }

  return { reviewIncomingEmail, runDailyReview, prepareHistoryImport, importHistory, localDate: () => localDate(now().getTime(), deps.timezone) };
}
