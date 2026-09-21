# Commitment follow-through (phase 6)

`PINGU_COMMITMENT_CAPTURE=true` enables private capture. `PINGU_COMMITMENT_NUDGES=due` separately enables reminders. Both are off by default. No third-party messages, email sends, Calendar bookings or automatic completion are performed.

## Sources and evidence

Every ten minutes, capture checks up to five unprocessed emails from the thirty most recent sent emails in the last seven days and incoming messages already tracked as actionable reply requests. It reads complete messages, removes common quoted/forwarded history and signatures, and extracts explicit first-person future promises. Requests, conditional offers, suggestions, negation and completed work are excluded. Each saved interpretation includes an exact verified quote and source link. Drafts, truncated messages, spam, trash and old mail are excluded.

When an outcome-led meeting review is saved, its explicit follow-ups are also offered to the commitment tracker. The quote must appear in transcript entries consistently attributed to the named person. Owner attribution requires an exact configured name match; other speakers also require Granola's `them` attribution. Anonymous or uncertain speakers remain in the review for manual clarification. This captures meetings processed through the outcome-review flow, not every historical Granola conversation.

Stable source identities prevent duplicate captures across retries and restarts. A completed or dismissed commitment stays closed when its source is processed again. Automatic capture processes each source once; later corrections or added commitments need review rather than silently changing previously reviewed obligations. The capture window is bounded, not an exhaustive historical mailbox audit. Similar promises in different sources are not automatically merged.

A sent email resolves an email-reply request, not a promised deliverable. Commitments close only through an explicit owner update or separately verified completion evidence. Tools expose the source quote, status history and whether capture was automatic.

## Dates and notifications

Automatic due-date capture deliberately accepts only an unambiguous, valid ISO date explicitly introduced by `by`, `on` or `due` in the supporting quotation. Other date wording stays in the quote; the owner can set the follow-up date in chat. Dates must not be invented from general urgency. Undated promises remain quietly tracked.

With due reminders enabled, the poller checks during 9am–6pm in the configured timezone. It sends one reminder per commitment for its explicit due date, in batches of up to three. It does not chase old overdue items or repeatedly resend the same due date. Sending is claimed durably before delivery; an uncertain acknowledgement is not retried. Closed items are checked again before delivery. All delivery goes through verified-owner direct-message checks. The Mac must be awake and connected.

The owner can mark an item done, dismiss it, or give a new date. Short displayed IDs are resolved using the private commitment list. Ambiguous references require clarification. Changing to a new date permits one reminder on that date; removing the date disables its reminder. These controls are available even when proactive reminders are disabled.

## Verification

`npm run check` includes regression tests for quote verification, quoted history, source age, draft exclusion, owner isolation, capture deduplication, speaker attribution, durable delivery claims, local quiet hours, status changes and rescheduling. `npm run eval:commitments` runs neutral live-model fixtures for explicit promises, conditional offers, negation, quoted history and prompt injection. It does not read a mailbox or create real commitments.

Phases 7 (written priorities) and 8 (notification feedback) remain separate work.
