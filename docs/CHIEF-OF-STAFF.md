# Approval-first chief of staff

## Purpose

Pingu should act as an approval-first chief of staff for its verified owner. It
reviews the owner's work context, identifies the few things that merit action,
prepares work in the owner's style, and asks for a clear approval before it
changes anything outside Pingu.

The product bar is not an inbox summary. Pingu should make a grounded
recommendation, explain why it made that recommendation, and prepare the next
step so the owner only needs to review and approve it.

This is a reusable product capability. Personal history, learned preferences,
and owner-specific rules remain in the local runtime data directory and are
never committed to this repository.

## Product decisions

| Area | Decision |
| --- | --- |
| Primary surface | iMessage, in the owner's direct chat |
| Owner identity | Verified against a handle allowlist captured at setup, with a pairing-code fallback |
| Daily review | 9:00am every day in the configured owner timezone |
| Missed review | One fresh briefing on restart, rebuilt from current state, skipped when the window is more than 6 hours stale |
| New email | Review the relevant thread when a new email arrives; notify only when there is a credible recommendation or prepared draft |
| Mail arrival | Incremental Gmail history polling is the required path; Pub/Sub push is an optional optimisation |
| Email | Pingu may prepare a Gmail draft after approval; the owner always sends it manually in Gmail |
| Draft signature | Proposal drafts carry the standard Pingu signature, same as every other draft |
| Existing send path | Unchanged for ad-hoc requests; proposal drafts can never enter it |
| Calendar | Pingu proposes a same-day reshuffle; every calendar change requires approval |
| History | Past sent mail and calendar history may be processed locally to learn preferences |
| Autonomy | No external side effect is allowed without explicit owner approval |
| Learning | Learn from approvals, edits, rejections, deferrals, and explicit ignore decisions |
| Ledger storage | SQLite through Node's built-in `node:sqlite` |
| Telemetry | Opt-in, defaulting to off |

## Non-goals

- Automatically sending an email, message, invite, or RSVP.
- Moving, creating, editing, or deleting a calendar event without approval.
- Treating silence as an intentional decision by default.
- Publishing source emails, calendar entries, contacts, preferences, or learned
  rules in the public repository.
- Replacing Gmail or Google Calendar as the place where the owner sends email
  and manages their final calendar.
- Removing Pingu's existing ad-hoc "email this person for me" flow. That flow
  keeps its confirm-then-send behaviour and is out of scope for this document
  except where noted in §0.3.

## Owner experience

### Daily briefing

At 9:00am, Pingu sends one concise iMessage briefing. It is a queue of
decisions, not a feed of every new email.

Example:

> Morning. Three things need a call:
>
> 1. Draft ready for Alex. You normally reply to these within a day.
> 2. Today is overbooked. I prepared a schedule that keeps your lesson order.
> 3. You deferred this opportunity twice. Ignore it, or pick a new date?

The owner can reply with `approve 1`, `edit 1`, `ignore 3`, `not now Friday`,
`why 2`, or `show today`.

If Pingu is unavailable at 9:00am, it sends one catch-up briefing after it
starts again, rebuilt from current state rather than replaying missed windows.
If the missed window is more than 6 hours old, Pingu skips the briefing and
says plainly that the window was missed, rather than presenting stale ranking
as a morning review. Delivery is recorded before the message is sent, so a
crash between sending and recording cannot produce a duplicate.

### Incoming email

When a new email arrives, Pingu evaluates only the relevant thread and the
minimum surrounding context needed to decide whether to interrupt the owner.

It sends an iMessage only when one of these is true:

- a response or decision is time-sensitive;
- the sender or topic is important according to recorded owner preferences;
- a conflict, deadline, or calendar implication needs a decision; or
- Pingu has a high-confidence draft ready for review.

Otherwise, the item remains available for the next daily briefing. This avoids
turning every inbox notification into a Pingu notification.

Until the preference service exists (§3), the second and third criteria have no
evidence to draw on. Before then, Pingu interrupts **only** when it has a
high-confidence draft ready. Everything else waits for 9:00am. This default
prevents the interruption logic from either flooding the owner or going silent
while the preference store is still empty.

### Email proposal and approval

Before asking for a person's address, Pingu searches the owner's mail for a
reliable header association. Before drafting, it searches the thread and
relevant sent mail for context and tone.

An email proposal includes the recipient, subject, complete body, source
thread, and a short explanation of why it is worth acting on. Approval creates
a Gmail draft in the original thread when possible. Pingu then confirms that
the draft is ready in Gmail. It does not send the email.

If Pingu finds conflicting addresses or cannot establish a reliable
association, it shows the options or asks a narrow question. It never guesses.
This overrides the existing agent instruction to infer `firstname@company-domain`
and act immediately; see §0.4.

Proposal drafts carry the standard Pingu signature, exactly as every other
Pingu-created draft does. This is deliberate: attribution stays honest even
though the body is written in the owner's voice, and the owner can remove the
line in Gmail before sending.

### Calendar proposal and approval

When Pingu identifies a same-day scheduling problem, it prepares a full,
conflict-free proposal. The owner sees every affected event with its current
and proposed time.

The planner must preserve:

- hard events, meetings, and protected blocks;
- event durations, attendees, locations, descriptions, colours, and recurrence
  semantics unless the proposal explicitly changes them;
- event order and declared sequence dependencies; and
- the relationship between moved prerequisite work and downstream work.

For example, moving an earlier lesson in a learning sequence requires Pingu to
replan later dependent lessons rather than leaving the sequence invalid.

On approval, Pingu re-reads the affected calendar events, confirms the plan is
still valid, applies the changes in the order defined in §5, then reads the
events back before reporting success.

### Deferral and deliberate non-action

The owner can explicitly communicate non-action in natural language:

- `ignore` suppresses this item and teaches Pingu not to surface materially
  similar items without a new signal.
- `not now` defers it and asks for or suggests a date.
- `not important` lowers the priority of a sender, category, or opportunity.
- `always surface` creates a stronger preference for a sender or category.
- `why this?` shows the evidence, prior decisions, and confidence behind the
  recommendation.

Pingu may infer a pattern only after repeated, consistent owner decisions. It
must represent inferred preferences as revisable hypotheses, not facts.

A proposal that expires without a decision is not a decision. Expiry is never
recorded as a learning signal, is never counted as an ignore, and never lowers
a sender's priority. An expired item may be re-proposed if its source is still
live at the next review.

## Functional scope

### 0. Owner verification and integration seams

This section exists because the rest of the document depends on primitives the
codebase does not currently have. It must land before any of §1–§7.

#### 0.1 Owner verification

Pingu has no concept of owner identity today. `settings.ownerName` is a string
used only in the model prompt. The entire privacy model is `spaceKind(space)`
in `src/message-pipeline.ts` producing an `isGroup` flag, checked in exactly one
place: the private-tool gate in `PluginRegistry.run` (`src/plugins.ts`). Any
person who sends a direct message to the Pingu line is currently treated as the
owner and reaches Gmail, Calendar, and Granola.

Requirements:

- Setup captures one or more owner iMessage handles and stores them in the
  encrypted configuration document.
- Every inbound message resolves to `verifiedOwner: boolean` before the model
  runs. Resolution failure fails closed.
- If the Spectrum SDK does not expose a sender handle on `Message`, fall back to
  a one-time pairing code shown in the setup wizard: the owner texts the code,
  and Pingu binds that space as the owner space. The implementation must
  establish which path is available before building on it, and the wizard must
  state which one is in force.
- The owner space id is persisted so proactive delivery has a destination. Until
  it is bound, no briefing is sent and setup says so plainly.
- Re-verification is required after a configuration change to the handle list.

#### 0.2 Proactive delivery has no privacy gate

The only audience check in the system lives inside tool dispatch. Scheduler
deliveries bypass it entirely: the reminder and email-alert schedulers in
`src/agent.ts` call `space.send` directly with no check of any kind. Email
alerts are safe today only incidentally, because `create_email_alert` is
private-by-default and so cannot be created from a group.

The briefing is a scheduler delivery and inherits no protection. Requirement:
every proactive delivery path performs its own check that the target space is
the bound owner space and is a direct chat, immediately before sending. This
check is a shared function, not a per-call-site convention.

#### 0.3 Approval commands must not collide with the send confirmation

`consumePendingEmailConfirmation` runs on every inbound message before the
model, and `isExplicitEmailConfirmation` currently matches a bare `yes`. A
pending draft stays armed for 30 minutes after review. That produces a live path
to sending mail this document forbids: the owner replies `approve 1`, Pingu
creates a draft, the pipeline renders and arms it, the owner says `yes` meaning
"and do item 2 as well", and `send_gmail_draft` sends.

Requirements:

- Proposal-created drafts never enter the pending-email store and are never
  armable for sending. The proposal path uses its own draft creation operation
  (§4), not `create_gmail_draft`.
- `isExplicitEmailConfirmation` is tightened so a bare `yes` no longer confirms
  a send. An explicit `send it` or equivalent is required.
- The ad-hoc confirm-then-send flow otherwise keeps its current behaviour.
- Tests cover the interleaving directly: a proposal approval and an armed
  ad-hoc draft in the same chat, with the owner replying `yes`.

#### 0.4 Contact inference contradicts "never guesses"

The agent instructions in `src/agent.ts` and the email-alerts plugin
instructions both tell the model to infer `firstname@company-domain` and act in
the same turn. Scope that instruction to alert creation only, and state in the
proposal path's instructions that recipient addresses are established by mail
search or by asking, never by inference.

#### 0.5 Proactive messages are invisible to the model

Replies are generated inside an OpenAI conversation keyed by space
(`src/conversations.ts`, `createReplyGenerator`). A `space.send` from a
scheduler never enters that conversation, so when the owner replies `approve 1`
the model has no record of the briefing.

Requirement: proposal commands are parsed **deterministically, before the model
runs**, against the ledger — not interpreted by the model. The parser resolves
an ordinal to a proposal id using the binding recorded for the delivered
briefing. Ordinals from a superseded briefing are rejected with a message
naming the current briefing, never silently rebound to a different item.

#### 0.6 Shared primitives

- **Clock.** The orchestrator, scheduler, ledger, and planner take an injectable
  clock. Testing 9:00am boundaries, DST, expiry, and the catch-up window
  requires it.
- **Timezone arithmetic.** `localDateTimeToUtc` in `src/reminders.ts` and
  `calendarTimestamp` in `src/capabilities/calendar.ts` are already two
  implementations of the same DST-correct conversion. Extract one shared utility
  and use it; do not add a third.
- **Node version.** `node:sqlite` requires Node 22.5.0 or newer. Tighten
  `engines.node` from `>=22` accordingly. It runs unflagged on Node 22 but emits
  an `ExperimentalWarning`; the API may change across Node releases, so the
  ledger's SQL access is confined to one module.
- **Telemetry.** `Spectrum({ telemetry: true })` in `src/agent.ts` is currently
  unconditional. Move it behind a configuration flag defaulting to off.

### 1. Review orchestration

Create a review orchestrator with two entry points:

1. scheduled daily review at 9:00am; and
2. inbound-email review for a newly received Gmail message.

The orchestrator gathers candidate items, enriches them with limited relevant
history, ranks them, and produces approval proposals. It must deduplicate an
item that was already proposed, deferred, or resolved.

The daily review considers:

- unread or recently changed email threads;
- open proposals and deferrals that are due;
- today's calendar and deadlines inferred from relevant email; and
- work blocks whose sequence or timing is no longer feasible.

The orchestrator takes its Gmail and Calendar ports and its clock as
constructor arguments, so every ranking and deduplication rule is testable
against fixtures with no live account.

The briefing tick reuses `startPoller` (`src/poller.ts`), which already runs
immediately on start — that is what makes restart catch-up work without extra
machinery.

### 2. Decision ledger

Add a local, versioned decision ledger in SQLite via `node:sqlite`, stored under
the runtime data directory. It is the source of truth for proposals, approvals,
and learned preferences; it is separate from raw chat transcripts and separate
from the JSON stores used by reminders, alerts, and pending emails.

Each proposal records:

- stable proposal id and status;
- source references, such as Gmail thread and Calendar event ids;
- for calendar sources, the `etag` and `updated` value of each affected event as
  read at proposal time;
- proposed action and its canonical payload hash;
- supporting evidence and confidence;
- creation, expiry, approval, execution, and final verification timestamps;
- owner feedback, including edits, rejection, deferral, and ignore reason; and
- links to any derived preference rule.

Statuses are `proposed`, `approved`, `executing`, `completed`,
`partially_completed`, `rejected`, `deferred`, `ignored`, `expired`, and
`invalidated`.

Approvals are single-use. Any material source or payload change invalidates the
proposal and requires a new approval.

The ledger stores **references and hashes, not content**. Gmail message and
thread ids, calendar event ids, and a hash of the evidence are durable; email
bodies and calendar descriptions are re-read from the provider when needed.
This bounds ledger growth and keeps source content out of a second location.

Briefing deliveries are also ledger rows, keyed by review window, written
before the message is sent so the window cannot be claimed twice.

### 3. Preference learning

Build a local preference service that produces explainable suggestions, rather
than an opaque personality profile.

Initial signals:

- approved, edited, rejected, deferred, and ignored proposals;
- owner edits to generated drafts;
- selected sent-email history, including response timing and style; and
- calendar history, including attendance, reschedules, protected hours, and
  repeatedly completed or deferred work blocks.

Expiry without a decision is not a signal (see "Deferral and deliberate
non-action").

Every preference needs a confidence, evidence count, last-confirmed time, and an
expiry or review policy. A user instruction always overrides an inferred
preference.

Examples:

- "Reply to this sender within a day" based on repeated approved drafts.
- "Do not surface newsletters from this domain" based on explicit ignores.
- "Protect this daily study block" based on repeated owner-approved calendar
  plans.

### 4. Gmail draft workflow

Extend the Gmail capability with a proposal-backed draft creation operation,
separate from `create_gmail_draft` so proposal drafts stay out of the
pending-email store (§0.3).

Requirements:

- Search inbox and sent mail before requesting contact details or drafting when
  that context is relevant.
- Use full email bodies within existing bounded-read limits
  (`GMAIL_BODY_CHAR_LIMIT`).
- Preserve thread and reply headers when creating a reply draft. Three concrete
  changes are needed and none of them exist today:
  - `readMessage` in `src/google.ts` requests only
    `["From","To","Subject","Date"]` as metadata headers. Add `Message-ID` and
    `References`, and surface them on `GmailMessage`.
  - `buildRawEmail` emits no `In-Reply-To` or `References` headers. Add them.
  - `createDraft` does not pass a `threadId`. Extend `GmailPort.createDraft` to
    accept one and pass it to `drafts.create`.
- Apply the standard Pingu signature, as `appendPinguSignature` already does for
  every draft.
- Create a Gmail draft only after an owner-approved proposal.
- Read back the draft metadata and confirm that the draft exists before
  reporting success.
- Never expose another person's email content to guests or group chats.

The existing `gmail.compose` scope is sufficient for threaded draft creation. No
scope change is required for this section.

### 5. Calendar planning workflow

Introduce a planner above the existing Google Calendar capability. It produces a
complete plan before invoking event mutation tools.

Much of the safety machinery already exists in `bulk_reschedule_calendar_events`:
duplicate rejection, duration preservation, destination conflict checks,
sequence-order validation, rollback of applied moves, and read-back
verification. The planner builds on that rather than replacing it. What is
genuinely new is listed below.

Requirements:

- Model hard constraints, soft preferences, event durations, buffers, minimum
  notice, and working hours.
- Model ordered sequence groups and prerequisite relationships. The existing
  title-based inference (`inferredSequenceGroup`) remains the fallback; the
  planner may pass explicit groups.
- Detect a cascade when moving an item makes a downstream event invalid.
- Include creates, moves, edits, and deletes in one reviewed plan, with an
  explicit per-event change set.
- **Stale-plan invalidation.** `prepareMoves` re-reads each event but validates
  only its duration; nothing compares the event against the state the plan was
  built from. Capture each affected event's `etag` and `updated` at proposal
  time, store them in the ledger (§2), compare `updated` before mutating so the
  failure message is legible, and pass `If-Match` with the stored `etag` on the
  mutation so the provider enforces it. This requires extending `CalendarPort`,
  which has no etag surface today.
- **Execution order and reversibility.** The plan applies in one fixed order:
  creates, then moves and edits, then verification, then deletes. Creates,
  moves, and edits roll back on failure, as `applyMovePlan` already does.
  Deletes are not reversible, so they run last, only after every other change
  verifies, and a failure part-way through deletion is reported as
  `partially_completed` with the exact count — which is what the existing
  duplicate-cleanup path already does. "Atomic" in this document means this
  ordering plus rollback of the reversible operations; it does not mean a
  provider transaction, which Google Calendar does not offer.
- Re-check busy conflicts and source versions before mutation.
- Verify each result with a Google Calendar read-back.
- Report partial completion visibly and retain enough ledger state to retry
  safely.

The first release is limited to same-day reshuffles. Cross-day replanning,
recurrence editing, attendee changes, and bulk deletion remain separate,
explicitly approved flows.

### 6. iMessage proposal interface

Add an owner-only proposal renderer and command parser. It supports numbered
proposals, concise summaries, full detail on request, and natural-language
approval or feedback.

The parser is deterministic and runs before the model (§0.5). The renderer runs
behind the proactive-delivery audience check (§0.2).

The renderer should optimize for one-screen messages. It must make the
side-effect boundary unambiguous, for example: "Approve to create this Gmail
draft" or "Approve to apply these three calendar changes."

### 7. Trigger and connector design

Use the native Gmail and Calendar capabilities as the production path. They need
OAuth scope control, reliable provider read-backs, local approval state, and
strong privacy boundaries.

**Gmail arrival detection.** Incremental polling is the required path and ships
first: store a Gmail `historyId`, call `users.history.list` from it on each
tick, and perform a full resync when Google returns `404` for an expired
`historyId`. This replaces the pattern used by the existing email-alert poller,
which queries `after:<unix seconds>` and keeps a truncated 100-id seen list —
that approach is lossy at second granularity, caps at ten results per tick, and
should not be extended to carry proposals.

Pub/Sub push is an optional optimisation for installs that have a public URL.
Where it is enabled it requires a Pub/Sub topic, an IAM grant to
`gmail-api-push@system.gserviceaccount.com`, a push endpoint that verifies the
Pub/Sub JWT, and `users.watch` renewal within seven days. Polling remains active
as the fallback whenever push is unconfigured or the watch has lapsed. Incoming
events must be idempotent under either path.

Future MCP connectors may supply read-only evidence or optional sources such as
task trackers, notes, CRM, and messaging tools. An MCP source cannot bypass the
proposal, approval, verification, transcript, or audience-policy layers.

## Safety and privacy requirements

- This system is available only to a verified owner (§0.1) in a direct chat.
- Guests and groups cannot see private sources, proposals, or learned
  preferences. Proactive delivery enforces this itself (§0.2).
- No external side effect occurs without a current explicit approval.
- Proposal execution must be idempotent and protected against duplicate
  iMessage delivery. The review window is claimed in the ledger before the
  briefing is sent, not after.
- A provider failure is always surfaced to the owner. Pingu must not claim an
  action happened until provider read-back verifies it.
- Raw source data, compact preferences, decision ledger, and transcripts have
  documented local retention and deletion behaviour (see below).
- Telemetry is opt-in, defaults to off, and excludes source content and learned
  preferences.

### Retention

These defaults are deliberate starting points and are revisable once real
volumes are known:

| Data | Retention | Deletion |
| --- | --- | --- |
| Decision ledger proposals | 180 days after terminal status | Automatic sweep, plus an owner command |
| Briefing delivery records | 90 days | Automatic sweep |
| Preference rules | Until superseded or explicitly deleted | Owner command, per rule |
| Cached source evidence | Not stored; re-read from the provider | Not applicable |
| Gmail `historyId` cursor | Current value only | Reset on full resync |

Source content is never copied into the ledger (§2), which is what makes this
table short.

## Delivery plan

### Milestone 0: owner verification and integration seams

- Owner handle allowlist in setup, pairing-code fallback, and `verifiedOwner`
  resolution that fails closed.
- Owner space binding and persistence.
- Shared proactive-delivery audience check.
- Tightened send confirmation and proposal/pending-email isolation.
- Scoped contact-inference instructions.
- Injectable clock, shared timezone utility, `engines.node` bump, telemetry
  flag.
- Tests: unverified DM reaches no private tool; a bare `yes` does not send;
  proactive delivery to a non-owner space is refused.

### Milestone 1: proposals, triage, and daily briefing

- Decision ledger and proposal lifecycle in `node:sqlite`.
- Read-only Gmail thread triage and ranking, so the first briefing is real.
- 9:00am scheduled owner briefing with staleness-bounded catch-up and
  window-claim deduplication.
- Deterministic iMessage command parser for approve, edit, ignore, defer, and
  explain.
- Neutral fixture-based tests for idempotency, expiry, ordinal rebinding, and
  owner-only access.

### Milestone 2: Gmail trigger and drafts

- Incremental `history.list` polling with full-resync fallback.
- Optional Pub/Sub push behind configuration.
- Search-first contact lookup and context retrieval.
- Threaded reply headers (`Message-ID`, `References`, `In-Reply-To`,
  `threadId`).
- Draft-on-approval creation, Gmail read-back, and no-send guarantee.

### Milestone 3: same-day calendar plans

- Constraint and dependency model.
- Full same-day reshuffle preview.
- Etag and `updated` capture, `If-Match` mutation, stale-plan invalidation.
- Fixed execution ordering, conflict checks, and read-back verification.
- Tests for cascaded sequences, duplicate prevention, conflicts, stale plans,
  and partial provider failure.

### Milestone 4: learned preferences

- Local historical import with progress and deletion controls.
- Explainable preference rules and confidence calibration.
- Learning from proposal outcomes and owner draft edits.
- `why this?`, correction, and preference deletion flows.
- Interruption criteria beyond "draft ready" become active here.

### Milestone 5: optional connectors

- Connector contract for evidence-only MCP sources.
- Per-source OAuth, scopes, privacy policy, and capability declarations.
- Connectors graduate to proposal-producing actions only after they satisfy the
  same approval and verification contract as Gmail and Calendar.

## Acceptance criteria

- An unverified sender in a direct chat reaches no private tool, no proposal,
  and no learned preference.
- At 9:00am, the verified owner receives one concise briefing and never a
  duplicate for the same review window, including across a restart between
  claiming the window and sending.
- A briefing missed by more than six hours is skipped with an explanation
  rather than delivered stale.
- A new important email can produce a proposal; a routine email waits for the
  daily review.
- Approving an email creates a Gmail draft and never sends mail. A reply of
  `yes` following an approval never sends an unrelated armed draft.
- A reply draft appears in the original Gmail thread with correct reply
  headers.
- Pingu explains the evidence and confidence for a recommendation on request.
- Ignoring or deferring an item changes later recommendations predictably; an
  expired item changes nothing.
- An ordinal from a superseded briefing is rejected, not rebound.
- A calendar proposal lists every affected event and maintains declared
  dependency order.
- A stale calendar plan cannot overwrite a newly changed event, enforced by the
  provider through `If-Match` and not only by a pre-flight read.
- Any failed provider operation is reported clearly and is never described as
  complete. A failure during the delete phase reports partial completion with
  exact counts.
- Owner history and learned preferences remain local and are absent from public
  source, tests, fixtures, and documentation examples.

## Open questions

- Does the Spectrum SDK expose a sender handle on `Message`? This decides
  whether §0.1 ships the allowlist or the pairing-code fallback as the primary
  path. It must be answered before Milestone 0 is estimated.
- Should `node:sqlite`'s `ExperimentalWarning` be suppressed at startup, or
  surfaced so the operator knows the dependency is experimental?
- What is the right ranking cap for a briefing — the examples show three items,
  but no rule is stated for what happens on a day with twelve candidates.
