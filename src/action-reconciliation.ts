import { decodeHeader, sameAddresses, type GmailPort } from "./capabilities/gmail.js";
import type { CalendarPort } from "./capabilities/calendar.js";
import type { ProposalLedger } from "./proposals.js";
import type { EmailDraftProposalPayload, CalendarMoveProposalPayload } from "./proposal-actions.js";

/** Read-only recovery: absence or a mismatch never authorises another write. */
export async function reconcileActions(ledger: ProposalLedger, gmail: GmailPort, calendar: CalendarPort, ownerSpaces: readonly string[], now = new Date()): Promise<number> {
  let recovered = 0;
  for (const proposal of ledger.uncertainActions()) {
    const last = ledger.getMetadata(`reconcile:${proposal.id}`);
    if (last && now.getTime() - Date.parse(last) < 5 * 60_000) continue;
    ledger.setMetadata(`reconcile:${proposal.id}`, now.toISOString());
    if (!ownerSpaces.includes(proposal.ownerSpaceId)) continue;
    try {
      if (proposal.kind === "email_draft" && gmail.readDraft) {
        const payload = proposal.payload as EmailDraftProposalPayload;
        let knownId: string | undefined;
        try { const outcome = JSON.parse(proposal.outcome ?? "{}"); if (typeof outcome.draftId === "string") knownId = outcome.draftId; } catch { /* Legacy outcomes are plain text. */ }
        const marker = `<pingu-${proposal.id}@pingu.local>`;
        const ids = knownId ? [knownId] : await gmail.findDraftIds?.(marker) ?? [];
        if (ids.length !== 1) continue;
        const draft = await gmail.readDraft(ids[0]!);
        const m = draft.message;
        if (!m || draft.id !== ids[0] || (!knownId && m.messageIdHeader !== marker)
          || (payload.threadId && m.threadId !== payload.threadId)
          || !sameAddresses(m.to, payload.to) || !sameAddresses(m.cc, payload.cc ?? []) || !sameAddresses(m.bcc, payload.bcc ?? [])
          || decodeHeader(m.subject) !== payload.subject || !payload.body.trim() || !m.body.includes(payload.body.trim())) continue;
        if (ledger.completeReconciled(proposal.id, JSON.stringify({ verified: true, draftId: ids[0], reconciledAt: now.toISOString() }), now)) recovered++;
      } else if (proposal.kind === "calendar_move") {
        const payload = proposal.payload as CalendarMoveProposalPayload;
        // Deletions require stronger provider evidence; never infer them from a failed read.
        if (!Array.isArray(payload.moves) || !payload.moves.length || payload.duplicateEventIds?.length) continue;
        let matches = true;
        for (const move of payload.moves) {
          const event = await calendar.getEvent(move.eventId);
          const start = event?.start as { dateTime?: string } | undefined;
          const end = event?.end as { dateTime?: string } | undefined;
          if (!event || event.status === "cancelled" || !move.newStart || !move.newEnd
            || !start?.dateTime || !end?.dateTime
            || Date.parse(start.dateTime) !== Date.parse(move.newStart)
            || Date.parse(end.dateTime) !== Date.parse(move.newEnd)) { matches = false; break; }
        }
        if (matches && ledger.completeReconciled(proposal.id, "All requested calendar times verified by read-only reconciliation.", now)) recovered++;
      }
    } catch { /* Provider unavailability or malformed evidence leaves the action held. */ }
  }
  return recovered;
}
