import { createVerifiedGmailDraft, type GmailPort } from "./capabilities/gmail.js";
import { applyVerifiedCalendarMovePlan, type CalendarPort, type RescheduleMove } from "./capabilities/calendar.js";
import { ProposalLedger, type Proposal } from "./proposals.js";

export interface EmailDraftProposalPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  sourceMessageId?: string;
}

export interface CalendarMoveProposalPayload {
  moves: RescheduleMove[];
  duplicateEventIds?: string[];
  timezone: string;
  bufferMinutes?: number;
}

function emailPayload(proposal: Proposal): EmailDraftProposalPayload {
  const value = proposal.payload as Partial<EmailDraftProposalPayload>;
  if (!Array.isArray(value.to) || value.to.length === 0 || typeof value.subject !== "string" || typeof value.body !== "string") {
    throw new Error("The approved email proposal is incomplete.");
  }
  return { to: value.to, cc: value.cc ?? [], bcc: value.bcc ?? [], subject: value.subject, body: value.body, ...(value.threadId ? { threadId: value.threadId } : {}), ...(value.inReplyTo ? { inReplyTo: value.inReplyTo } : {}), ...(value.references ? { references: value.references } : {}), ...(value.sourceMessageId ? { sourceMessageId: value.sourceMessageId } : {}) };
}

function proposalDetail(proposal: Proposal): string {
  if (proposal.kind !== "email_draft") return proposal.detail;
  const draft = proposal.payload as Partial<EmailDraftProposalPayload>;
  return [`To: ${(draft.to ?? []).join(", ")}`, `Subject: ${draft.subject ?? ""}`, "", draft.body ?? proposal.detail].join("\n");
}

function proposalExplanation(ledger: ProposalLedger, proposal: Proposal): string {
  const evidence = [proposal.evidence.sourceType, proposal.evidence.contact, proposal.evidence.category].filter(Boolean).join(", ");
  const ruleKeys = [...(proposal.evidence.ruleIds ?? []), ...(proposal.preferenceKey ? [proposal.preferenceKey] : [])];
  const rules = new Map(ledger.preferences().map((rule) => [rule.key, rule]));
  const prior = [...new Set(ruleKeys)].flatMap((key) => rules.has(key) ? [`${key}: ${rules.get(key)!.value}`] : []);
  return [
    proposal.evidence.rationale,
    evidence ? `Evidence: ${evidence}.` : undefined,
    prior.length ? `Guidance considered: ${prior.join("; ")}.` : "No prior preference rule was supplied.",
    `Confidence: ${Math.round(proposal.evidence.confidence * 100)}%.`,
  ].filter(Boolean).join(" ");
}

function decisionPreferenceKey(proposal: Proposal, decision: string): string {
  const subject = proposal.evidence.contact
    ? `contact:${proposal.evidence.contact.toLowerCase()}`
    : proposal.evidence.category ? `category:${proposal.evidence.category}` : `source:${proposal.evidence.sourceType}`;
  return `${proposal.kind}:${subject}:${decision}`;
}

export async function executeEmailDraftProposal(ledger: ProposalLedger, gmail: GmailPort, proposal: Proposal): Promise<string> {
  const claimed = ledger.claimExecution(proposal.id);
  if (!claimed) return "That proposal is already being handled or is no longer current.";
  try {
    const payload = emailPayload(claimed);
    if (payload.threadId && payload.sourceMessageId && gmail.readThread) {
      const thread = await gmail.readThread(payload.threadId);
      const latest = thread.at(-1)?.id;
      if (latest && latest !== payload.sourceMessageId) {
        ledger.settle(proposal.id, "invalidated", "A newer message arrived in the Gmail thread.");
        return "A newer reply arrived in that thread. I’ll prepare a fresh draft.";
      }
    }
    await createVerifiedGmailDraft(gmail, payload);
    const outcome = "Draft created and verified in Gmail for manual sending.";
    ledger.settle(proposal.id, "completed", outcome);
    const preference = ledger.recordPreference({ key: `email:${proposal.evidence.contact ?? "unknown"}:approved`, value: "Owner approved a drafted reply.", confidence: 1, evidenceCount: 1 });
    ledger.linkPreference(proposal.id, preference.key);
    return "Draft’s in Gmail. Review and send it there.";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gmail draft creation failed.";
    ledger.settle(proposal.id, "failed", message);
    return `I couldn't create that Gmail draft: ${message}`;
  }
}

export async function executeCalendarMoveProposal(ledger: ProposalLedger, calendar: CalendarPort, proposal: Proposal): Promise<string> {
  const claimed = ledger.claimExecution(proposal.id);
  if (!claimed) return "That proposal is already being handled or is no longer current.";
  try {
    const payload = claimed.payload as Partial<CalendarMoveProposalPayload>;
    if (!Array.isArray(payload.moves) || payload.moves.length === 0 || typeof payload.timezone !== "string") {
      throw new Error("The approved calendar proposal is incomplete.");
    }
    for (const move of payload.moves) {
      const current = await calendar.getEvent(move.eventId);
      if (!current) throw new Error(`Calendar event ${move.eventId} no longer exists.`);
      if (move.expectedEtag && current.etag !== move.expectedEtag) throw new Error(`Calendar event ${move.eventId} changed after the proposal.`);
      if (move.expectedUpdated && current.updated !== move.expectedUpdated) throw new Error(`Calendar event ${move.eventId} changed after the proposal.`);
      const attendees = Array.isArray(current.attendees) ? current.attendees as Array<{ self?: boolean }> : [];
      if (current.recurringEventId || current.organizer?.self === false || attendees.some((attendee) => !attendee.self)) {
        throw new Error(`Calendar event ${move.eventId} changed after the proposal and is no longer an owner-controlled single event.`);
      }
    }
    const result = await applyVerifiedCalendarMovePlan(calendar, payload.moves, payload.duplicateEventIds ?? [], payload.timezone, { bufferMinutes: payload.bufferMinutes });
    const outcome = `${result.moved} event(s) moved and verified; ${result.deletedDuplicates} duplicate(s) deleted.`;
    ledger.settle(proposal.id, "completed", outcome);
    const preference = ledger.recordPreference({ key: "calendar:reshuffle:approved", value: claimed.summary, confidence: 1, evidenceCount: 1 });
    ledger.linkPreference(proposal.id, preference.key);
    return result.deletedDuplicates ? `Done. Moved ${result.moved}; deleted ${result.deletedDuplicates} duplicate${result.deletedDuplicates === 1 ? "" : "s"}.` : `Done. Moved ${result.moved} event${result.moved === 1 ? "" : "s"}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar reshuffle failed.";
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : undefined;
    const partial = /Rollback also failed|Moves verified, but duplicate cleanup/.test(message);
    ledger.settle(proposal.id, partial ? "partially_completed" : code === 412 || /changed after the proposal|no longer exists/.test(message) ? "invalidated" : "failed", message);
    if (partial) return `That calendar plan only partly completed: ${message} Check Calendar before approving a fresh plan.`;
    return `I couldn't apply that calendar plan: ${message}`;
  }
}

export async function executeHistoryImportProposal(ledger: ProposalLedger, proposal: Proposal, runImport: (proposal: Proposal) => Promise<void>): Promise<string> {
  const claimed = ledger.claimExecution(proposal.id);
  if (!claimed) return "That proposal is already being handled or is no longer current.";
  try {
    await runImport(claimed);
    ledger.settle(proposal.id, "completed", "The approved bounded history sample was learned into local preference rules.");
    return "History learned. I’ll use it as revisable guidance.";
  } catch (error) {
    const message = error instanceof Error ? error.message : "History import failed.";
    ledger.settle(proposal.id, "failed", message);
    ledger.setMetadata("chief-of-staff:history-previewed", "");
    return `I couldn't finish the history import: ${message}`;
  }
}

/** Only explicit briefing commands may bypass the ongoing conversation. */
export function isProposalCommand(text: string): boolean {
  return /^(?:preferences|show today|forget preference\s+\d+|(?:approve|reject|ignore|not important|why|show|done|got it|always surface)\s+\d+(?:\s*:\s*.+)?|not now\s+.+\s+\d+|edit\s+\d+(?:\s*:\s*[\s\S]+)?)$/i.test(text.trim());
}

export async function handleProposalCommand(input: {
  ledger: ProposalLedger;
  gmail: GmailPort;
  calendar?: CalendarPort;
  ownerSpaceId: string;
  texts: readonly string[];
  now?: Date;
  timezone?: string;
  runHistoryImport?: (proposal: Proposal) => Promise<void>;
}): Promise<string | undefined> {
  for (const text of input.texts) {
    if (!isProposalCommand(text)) continue;
    if (input.ledger.hasUnconfirmedBriefing(input.ownerSpaceId) && /^(?:approve|show|why|reject|ignore|done|got it|not now|not important|always surface|edit)\b/i.test(text.trim())) {
      return "I couldn’t confirm which briefing arrived. Ask me about the specific email instead of using its number.";
    }
    if (/^show today$/i.test(text.trim())) {
      const proposals = input.ledger.currentBriefingProposals(input.ownerSpaceId);
      return proposals.length ? proposals.map((proposal, index) => `${index + 1}. ${proposal.summary}\n${proposalDetail(proposal)}`).join("\n\n") : "There isn't a current briefing to show.";
    }
    if (/^not now$/i.test(text.trim())) return "Until when?";
    if (/^preferences$/i.test(text.trim())) {
      const rules = input.ledger.preferences();
      input.ledger.setMetadata(`preference-view:${input.ownerSpaceId}`, JSON.stringify(rules.map((rule) => rule.key)));
      return rules.length ? rules.map((rule, index) => `${index + 1}. ${rule.key}: ${rule.value} (${Math.round(rule.confidence * 100)}%)`).join("\n") : "No learned preferences yet.";
    }
    const forget = text.trim().match(/^forget preference\s+(\d+)$/i);
    if (forget) {
      const snapshot = input.ledger.getMetadata(`preference-view:${input.ownerSpaceId}`);
      const key = snapshot ? (JSON.parse(snapshot) as string[])[Number(forget[1]) - 1] : undefined;
      return key && input.ledger.deletePreference(key) ? "Forgot it." : "I can't match that preference number. Send “preferences” first.";
    }
    const edited = text.trim().match(/^edit\s+(\d+)\s*:\s*([\s\S]+)$/i);
    if (edited) {
      const ordinal = Number(edited[1]);
      const proposal = input.ledger.updateEmailDraftBody(input.ownerSpaceId, ordinal, edited[2]!.trim());
      if (proposal) {
        input.ledger.recordFeedback(proposal.id, "Owner replaced the generated draft body before approval.");
        const preference = input.ledger.recordPreference({ key: "email:draft:edited", value: "Owner commonly edits generated drafts before approval.", confidence: 1, evidenceCount: 1 }, input.now);
        input.ledger.linkPreference(proposal.id, preference.key);
      }
      return proposal ? `Updated. Reply “approve ${ordinal}” to create the Gmail draft.` : "I can't edit that current proposal.";
    }
    const editOnly = text.trim().match(/^edit\s+(\d+)$/i);
    if (editOnly) return `Send the replacement as “edit ${editOnly[1]}: your full draft”, then approve it.`;
    const feedbackMatch = text.trim().match(/^(ignore|reject|not important)\s+(\d+)\s*:\s*(.+)$/i);
    const commandText = feedbackMatch ? `${feedbackMatch[1]} ${feedbackMatch[2]}` : text;
    const command = input.ledger.parseCommand(input.ownerSpaceId, commandText, input.now, input.timezone);
    if (!command) continue;
    if (feedbackMatch) input.ledger.recordFeedback(command.proposal.id, feedbackMatch[3]!);
    if (command.type === "explain") return proposalExplanation(input.ledger, command.proposal);
    if (command.type === "show") {
      return proposalDetail(command.proposal);
    }
    if (command.type === "done") {
      const preference = input.ledger.recordPreference({ key: `proposal:${command.proposal.kind}:completed_elsewhere`, value: command.proposal.summary, confidence: 1, evidenceCount: 1 }, input.now);
      input.ledger.linkPreference(command.proposal.id, preference.key);
      return "Got it. Marked done.";
    }
    if (command.type === "always_surface") {
      const preference = input.ledger.recordPreference({ key: decisionPreferenceKey(command.proposal, "always_surface"), value: "Always surface materially similar items.", confidence: 1, evidenceCount: 1 }, input.now);
      input.ledger.linkPreference(command.proposal.id, preference.key);
      return "Got it. I’ll keep surfacing things like this.";
    }
    if (command.type === "reject") {
      const value = command.disposition === "ignored"
        ? "Suppress materially similar items unless a new urgent signal appears."
        : command.disposition === "not_important" ? "Treat materially similar items as low priority." : "The owner rejected this proposed action.";
      const preference = input.ledger.recordPreference({ key: decisionPreferenceKey(command.proposal, command.disposition), value: feedbackMatch?.[3] ?? value, confidence: 1, evidenceCount: 1 }, input.now);
      input.ledger.linkPreference(command.proposal.id, preference.key);
      return command.disposition === "not_important" ? "Got it. I’ll treat things like this as low priority." : command.disposition === "ignored" ? "Got it. I’ll suppress things like this unless something changes." : "Got it. I won't act on that.";
    }
    if (command.type === "defer") {
      const preference = input.ledger.recordPreference({ key: decisionPreferenceKey(command.proposal, "deferred"), value: `Owner deferred until ${command.until}.`, confidence: 1, evidenceCount: 1 }, input.now);
      input.ledger.linkPreference(command.proposal.id, preference.key);
      return `Deferred until ${command.until}.`;
    }
    if (command.proposal.kind === "email_draft") return executeEmailDraftProposal(input.ledger, input.gmail, command.proposal);
    if (command.proposal.kind === "email_fyi" || command.proposal.kind === "email_decision") return "This item needs no action from me. You can reply “done” when you’ve handled it.";
    if (command.proposal.kind === "history_import") {
      if (!input.runHistoryImport) return "I couldn't start that import because historical learning is off.";
      return executeHistoryImportProposal(input.ledger, command.proposal, input.runHistoryImport);
    }
    if (!input.calendar) return "I couldn't apply that calendar plan because Calendar isn't connected.";
    return executeCalendarMoveProposal(input.ledger, input.calendar, command.proposal);
  }
  if (input.texts.some(isProposalCommand)) {
    return "I can't match that to a current proposal. Reply with the number from the latest briefing.";
  }
  return undefined;
}
