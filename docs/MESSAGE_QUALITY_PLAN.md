# Message quality implementation

## Order and dependencies

1. Establish the baseline with `npm run check`; preserve existing local changes.
2. Persist delivery state and exact briefing text. Migrate historical deliveries so an upgrade does not replay old proposals. This is required by suppression and conversational context.
3. Select fresh proposals by deadline, importance, and action type. Interrupt with one item; daily review has at most three. Resurface only a newly imminent deadline or an explicit snooze becoming due. Empty reviews finish silently without replacing the last visible briefing.
4. Render ordinary briefings within 80 words, including help. Keep complete calendar and history-import approval disclosures as explicit exceptions. Never truncate the underlying action or draft.
5. Supply the last delivered briefing, rationale, and current proposal status to owner direct-message replies. Context is evidence, never authorization. Connect each owner's operating brief to email and calendar review.
6. Distinguish missing Gmail resources from temporary review failures, back off mailbox outages, and avoid repeating operational notices.
7. Run targeted scenario evaluations, then `npm run check` and `git diff --check`. Back up the local ledger before restarting and verify the process remains healthy. No publication or live test texts.

## Acceptance checks

- One new urgent message produces one proposal, with no old backlog attached.
- Five verbose ordinary proposals produce at most three items and 80 words, with one help footer.
- Repeating an unchanged day produces no message or repeated model review.
- Fresh urgent decisions outrank old FYIs; a deadline crossing the next-day threshold resurfaces once.
- Successful deliveries survive reopen; uncertain deliveries are held without resend and disable earlier numbered approvals.
- A silent review preserves the last visible briefing and its command references.
- Owner follow-ups receive the delivered text and rationale; guests/groups receive neither.
- Operating briefs and explicit message preferences are scoped to the owner during model review. No preference is inferred from silence.
- Missing source mail is not retried forever; temporary failures are retried with backoff.
- All existing approval, privacy, calendar, and delivery tests continue passing.

Automated evaluations use neutral local fixtures. They measure selection, size, state, and context wiring; they do not establish live-model judgement quality. Observe real usefulness after deployment through owner feedback, without treating non-response as consent or disinterest.

## Verification results

### Conversation continuity follow-up

Only explicit numbered briefing commands bypass conversation handling. Short answers such as “yes” and “two a day is okay” remain with the active task. Oversized tool exchanges are removed together while retaining the latest user request and assistant clarification. Recoverable model errors retry with dialogue preserved instead of clearing the chat. No previously discarded conversation is reconstructed or treated as new authorization.

Validation: 341 tests passed, with regressions for ordinary replies beside an active briefing, oversized calendar results, and model-error recovery. Type checks and production build passed.

### Freshness and delivery follow-up

The first evaluation omitted old unseen backlog, resolved threads, the running timezone, and a send accepted before its acknowledgement fails. These gaps are now covered by `chief-freshness.test.ts`. The feature revalidates source age, inbox status, and latest thread; excludes routine FYIs; permits older items only for an approaching deadline or explicit snooze; and checks the 9–10am window again after slow work. Unknown sends are retained without replay. Long summaries fall back to a complete sentence with details available rather than a cut-off fragment.

The local timezone is configured through LaunchAgent environment settings; private configuration is not stored in the repository. No provider-level delivery reconciliation is claimed: uncertain messages remain held, so a genuinely undelivered alert may be missed.

Validation: 338 tests passed across 45 files, including 17 freshness/delivery regression cases. TypeScript checks, the production build, and `git diff --check` passed. The local ledger and launcher were backed up before rollout.

### Initial iteration (superseded policies above)

- Baseline: 308 tests passed.
- Implementation: 321 tests passed across 44 files; TypeScript checks and production build passed.
- Ten message-quality scenarios cover size, repetition, ranking, deadline reminders, snoozes, migration, private reply context, uncertain delivery, complete approval disclosures, deleted source mail, and false urgency cues.
- Additional checks cover operating-brief prompt inputs, saved preference isolation, and mailbox backoff/recovery.
- `git diff --check` passed. Existing local workflow and interview work was preserved; no dependency changes were needed.
- Local rollout: backed up the ledger, migrated to schema 3, verified database integrity, and confirmed the replacement process connected and remained running. No test messages or GitHub publication were performed.
