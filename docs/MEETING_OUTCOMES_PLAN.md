# Outcome-led meeting follow-through

Phase 5 implements private pre-meeting goals and evidence-backed post-meeting assessments. Enable with `PINGU_MEETING_OUTCOMES=true` and `PINGU_VAULT_PATH`; Granola reviews also require a connected Granola account. It runs inside Pingu on the host, so the host must be awake and connected. Browser integration remains deferred.

## Before the meeting

The primary Calendar is checked every minute. About one hour before a timed meeting involving another person, Pingu asks once for goals, desired outcomes or asks if none are recorded. Personal and work meetings both qualify. Clearly labelled interviews, solo blocks, declined or cancelled events and all-day items are excluded. Events without attendee lists qualify only when their titles clearly indicate another person; ambiguous titles are not guessed.

Pingu rechecks the event before prompting, skips meetings that have started, and does not resend when delivery was uncertain. Each recurring occurrence has its own event identity; rescheduling the same occurrence does not create another reminder.

The pending question is retained across restarts and supplied to the reply handler. Replies save exact excerpts of the owner's current message, appending to existing goals unless replacement is explicitly requested. When several meetings could match, the assistant is instructed to ask which. The owner can explicitly skip goal-setting for an event. Pre-meeting goals cannot be rewritten after the meeting starts.

## Private storage

Goals are written to a versioned Obsidian brief in `meeting-notes/`. An existing structured brief for the same Calendar event is recognized, including its Goals section. An invitation agenda or an unlinked free-form note is not automatically treated as the owner's personal goals.

The brief contains a Calendar link. Calendar stores the reverse Obsidian link in **private extended properties**, which Pingu can read; this link is hidden in the normal Calendar interface. Shared invitation descriptions are unchanged. See Google's [private and shared event property documentation](https://developers.google.com/workspace/calendar/api/guides/extended-properties).

Calendar updates preserve other properties, use the current ETag, suppress invitations and verify the saved link. A failed link does not discard the private brief; the poller retries link verification. File writes recover from lost state acknowledgements and preserve the original capture time. Existing edited briefs are never overwritten.

## After the meeting

Every ten minutes Pingu checks recorded goals for meetings that ended at least fifteen minutes ago, for up to seven days. A Granola note must match the exact Calendar event ID and occurrence start. Missing or ambiguous links remain pending; title resemblance alone is insufficient. A transcript is required. No recording means no evidence-backed assessment.

Each outcome is assessed as **achieved / partly achieved / unresolved / not discussed**, with evidence and explicit follow-ups. “Not discussed” means no supporting discussion was found in the available recording, not certainty about unrecorded conversation. Positive conclusions require verified verbatim transcript quotations. Suggestions must not become promises. Principle and lesson connections require evidence from both the transcript and an existing vault note.

The result is a general-conversation digest with links to the original brief, Calendar and Granola, plus takeaways, next actions and open questions. The same digest is updated when the source changes. Personal annotations outside its generated section are preserved; edits within that section pause automatic replacement. Assessments are cached before file writes so recovery does not require another model judgement.

Current limits: at most twelve goals; transcripts over 140,000 serialized characters require a separate full review; at most 300 recently updated Granola notes are searched. Unlinked or ambiguous transcripts need manual resolution. Automatic reviews write private notes, not follow-up messages to attendees. Model assessments remain judgements for owner review despite quotation checks.

## Verification

Regression tests cover reminder timing and restarts, uncertain delivery, exclusions, changed events, recurring occurrences, existing goals, private Calendar fields, lost acknowledgements, preserved annotations, owner isolation, complete outcome coverage, fabricated quotes and ambiguous Granola matches. `npm run eval:meetings` uses a neutral live-model fixture to check an agreed result, a tentative suggestion, missing evidence and source prompt injection. Add `-- --readiness` for read-only Calendar/Granola access checks that print aggregate counts rather than meeting content.

## Subsequent phases

6. Extend follow-through to commitments across email and meetings, grounded in evidence and explicit ownership.
7. Compare upcoming commitments with current written priorities and surface actionable conflicts.
8. Use explicit feedback to tune notification relevance and reduce repeated low-value alerts.

These phases are approved direction, not claims that their new triggers are enabled by phase 5.
