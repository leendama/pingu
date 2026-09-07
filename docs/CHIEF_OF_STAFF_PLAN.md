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
| Owner identity | Reuse the existing verified-owner claim and bound owner-space records |
| Daily review | 9:00am every day in the configured owner timezone |
| Missed review | Catch up once only when the missed 9:00am window is less than six hours old |
| New email | Review the relevant thread when a new email arrives; notify only when there is a credible recommendation or prepared draft |
| Mail arrival | Gmail History API polling ships first; Pub/Sub push is an optional acceleration |
| Email | Pingu may prepare a Gmail draft after approval; the owner always sends it manually in Gmail; Pingu never sends email |
| Calendar | Pingu proposes a same-day reshuffle; every calendar change requires approval |
| History | Past sent mail and calendar history may be imported locally, with an explicit model-provider disclosure and bounded initial import |
| Autonomy | No external side effect is allowed without explicit owner approval |
| Learning | Learn from approvals, edits, rejections, deferrals, and explicit ignore decisions |
| Delivery semantics | A briefing is at-least-once: an uncertain send is retried and clearly labelled, rather than silently lost |

## Non-goals

- Sending any email, message, invite, or RSVP. Every email remains a Gmail
  draft until the owner manually sends it in Gmail.
- Moving, creating, editing, or deleting a calendar event without approval.
- Treating silence as an intentional decision by default.
- Publishing source emails, calendar entries, contacts, preferences, or learned
  rules in the public repository.
- Replacing Gmail or Google Calendar as the place where the owner sends email
  and manages their final calendar.

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

The scheduler calculates the next local 9:00am rather than running a daily
review on every process start. On restart it sends one catch-up briefing only
when the missed window is less than six hours old. It records `pending`,
`delivery_unknown`, or `delivered` for each review window. A crash after a
handoff to iMessage may cause one labelled retry; it must never silently mark a
briefing as delivered before it has evidence of delivery.

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

Before Pingu has learned preferences, a deterministic urgency policy still
interrupts for an explicit deadline today, a meeting cancellation or change,
an interview or booking change, a security or financial notice, or work due
within a configured time window. It must not wait for a high-confidence draft
when an urgent item needs a question from the owner.

### Email proposal and approval

Before asking for a person's address, Pingu searches the owner's mail for a
reliable header association. Before drafting, it searches the thread and
relevant sent mail for context and tone.

An email proposal includes the recipient, subject, complete body, source
thread, and a short explanation of why it is worth acting on. Approval creates
a Gmail draft in the original thread when possible. Pingu then confirms that
the draft is ready in Gmail. It does not send the email.

This applies to every Pingu email flow, including ad-hoc requests. The existing
send path is disabled in this mode and cannot be armed by a bare `yes` or by an
approval command for another proposal.

If Pingu finds conflicting addresses or cannot establish a reliable
association, it shows the options or asks a narrow question. It never guesses.

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

The first release is limited to moving existing, non-recurring events controlled
by the owner. It does not create or delete events, alter attendees, or edit a
recurring series. Those are separate proposal types after the move planner is
reliable.

On approval, Pingu re-reads the affected calendar events, confirms the plan is
still valid, applies the changes with conditional provider writes, then reads
them back before reporting success.

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

## Functional scope

### 0. Reuse existing identity and delivery foundations

Pingu already verifies owners by exact Spectrum sender id through a claim code,
stores the owner direct-chat space, and keeps private tools away from guests and
groups. This feature extends those primitives; it does not replace or duplicate
them.

Add one shared proactive-delivery guard. Immediately before any briefing or
proposal notice is sent, it verifies that the target is both a current verified
owner space and a direct chat. Owner removal invalidates outstanding proposals
for that sender.

Proposal commands are parsed deterministically before the model runs. An
ordinal such as `approve 1` resolves only against the delivered briefing it came
from. A stale ordinal is rejected, never rebound to a newer proposal.

All send confirmation paths are isolated from proposal execution. Proposal
drafts do not enter the pending-email store; a message that approves or defers
a proposal cannot send a different draft.

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

The scheduler takes an injectable clock and computes local 9:00am boundaries,
including DST. Restart catch-up is a deliberate scheduling decision, not a side
effect of a poller that runs immediately.

### 2. Decision ledger

Add a local, versioned SQLite decision ledger. It is the source of truth for
proposals, approvals, and learned preferences; it is separate from raw chat
transcripts.

Each proposal records:

- stable proposal id and status;
- source references, such as Gmail thread and Calendar event ids;
- proposed action and its canonical payload hash;
- supporting evidence and confidence;
- a minimal explanation snapshot: source type, contact or sender identifier,
  dates, category, rule ids, and rationale without quoted email or calendar
  content;
- creation, expiry, approval, execution, and final verification timestamps;
- owner feedback, including edits, rejection, deferral, and ignore reason; and
- links to any derived preference rule.

Suggested statuses are `proposed`, `approved`, `executing`, `completed`,
`partially_completed`, `rejected`, `deferred`, `ignored`, `expired`, and
`invalidated`.

Approvals are single-use. Any material source or payload change invalidates
the proposal and requires a new approval.

For calendar moves, store the source event ETag and use `If-Match` for the
mutation. A 412 response invalidates the proposal instead of overwriting a
calendar change made elsewhere. If a later release creates events, it must use
a ledger-backed client-generated id to make timeout retries idempotent.

### 3. Preference learning

Build a local preference service that produces explainable suggestions, rather
than an opaque personality profile.

Initial signals:

- approved, edited, rejected, deferred, and ignored proposals;
- owner edits to generated drafts;
- selected sent-email history, including response timing and style; and
- calendar history, including attendance, reschedules, protected hours, and
  repeatedly completed or deferred work blocks.

The historical import starts only after an owner-approved preview with a date
range, item count, and provider disclosure. When a hosted model is selected,
the source content needed for ranking or drafting can leave the machine for
that model provider. A local model keeps that inference on the machine.

Every preference needs a confidence, evidence count, last-confirmed time, and
an expiry or review policy. A user instruction always overrides an inferred
preference.

Examples:

- “Reply to this sender within a day” based on repeated approved drafts.
- “Do not surface newsletters from this domain” based on explicit ignores.
- “Protect this daily study block” based on repeated owner-approved calendar
  plans.

### 4. Gmail draft workflow

Extend the Gmail capability with a proposal-backed draft creation operation.

Requirements:

- Search inbox and sent mail before requesting contact details or drafting when
  that context is relevant.
- Use full email bodies within existing bounded-read limits.
- Preserve thread and reply headers when creating a reply draft.
- Create a Gmail draft only after an owner-approved proposal.
- Read back the draft metadata and confirm that the draft exists before
  reporting success.
- Never expose another person's email content to guests or group chats.
- Create a proposal draft through a separate operation that cannot send it.
- Classify sensitive source material. A lock-screen briefing says only that a
  sensitive item needs attention; `show <number>` reveals details in the owner
  chat.

### 5. Calendar planning workflow

Introduce a planner above the existing Google Calendar capability. It produces
a complete plan before invoking event mutation tools.

Requirements:

- Model hard constraints, soft preferences, event durations, buffers, minimum
  notice, and working hours.
- Model ordered sequence groups and prerequisite relationships.
- Detect a cascade when moving an item makes a downstream event invalid.
- Limit the first release to an explicit per-event move set for existing,
  non-recurring owner-controlled events.
- Re-check busy conflicts and source versions before mutation.
- Verify each result with a Google Calendar read-back.
- Report partial completion visibly and retain enough state to retry safely.

The first release is limited to same-day reshuffles. Cross-day replanning,
recurrence editing, attendee changes, and bulk deletion remain separate,
explicitly approved flows.

### 6. iMessage proposal interface

Add an owner-only proposal renderer and command parser. It supports numbered
proposals, concise summaries, full detail on request, and natural-language
approval or feedback.

The renderer should optimize for one-screen messages. It must make the
side-effect boundary unambiguous, for example: “Approve to create this Gmail
draft” or “Approve to apply these three calendar changes.”

### 7. Trigger and connector design

Use the native Gmail and Calendar capabilities as the production path. They
need OAuth scope control, reliable provider read-backs, local approval state,
and strong privacy boundaries.

For Gmail arrival detection, ship incremental Gmail History API polling first.
Persist a `historyId` only after every page and its proposal writes succeed. On
an expired cursor, perform a bounded full resync and establish a new baseline;
first install must not turn the whole historical inbox into proposals. Deduplicate
messages seen through a retry, a full resync, or a later Pub/Sub notification.

Pub/Sub push is an optional acceleration for installs with a public endpoint.
It requires a configured topic, verified push authentication, watch renewal,
and the same idempotent history processing as polling.

Future MCP connectors may supply read-only evidence or optional sources such
as task trackers, notes, CRM, and messaging tools. An MCP source cannot bypass
the proposal, approval, verification, transcript, or audience-policy layers.

## Safety and privacy requirements

- This system is available only to a verified owner in a direct chat.
- Guests and groups cannot see private sources, proposals, or learned
  preferences.
- No external side effect occurs without a current explicit approval.
- Proposal execution must be idempotent and protected against duplicate
  iMessage delivery.
- A provider failure is always surfaced to the owner. Pingu must not claim an
  action happened until provider read-back verifies it.
- Sensitive email and calendar content is not shown in lock-screen-previewable
  briefing text.
- Raw source data, compact preferences, decision ledger, and transcripts have
  documented local retention and deletion behaviour.
- `reset-data` removes the decision ledger, preference rules, proposal state,
  briefing records, and Gmail history cursor while preserving credentials under
  the existing reset policy.
- Telemetry remains opt-in and must exclude source content and learned
  preferences by default.

## Delivery plan

### Milestone 1: proposals and daily briefing

- Reuse verified-owner and owner-space records; add the shared proactive
  delivery guard.
- Decision ledger and proposal lifecycle, including delivery-unknown recovery.
- A real 9:00am scheduler with missed-run catch-up and deduplication.
- iMessage commands for approve, edit, ignore, defer, and explain.
- Neutral fixture-based tests for idempotency, expiry, stale ordinals,
  owner-only access, and restart around a review delivery.

### Milestone 2: Gmail triage and drafts

- Gmail incoming trigger and safe fallback.
- Thread-level triage and ranking.
- Deterministic urgent-email criteria before preference learning exists.
- Search-first contact lookup and context retrieval.
- Draft-on-approval creation, Gmail read-back, and no-send guarantee.

### Milestone 3: same-day calendar plans

- Constraint and dependency model.
- Full same-day reshuffle preview.
- Stale-plan invalidation, conflict checks, mutation orchestration, and
  read-back verification.
- Tests for cascaded sequences, duplicate prevention, conflicts, ETag
  invalidation, and partial provider failure.

### Milestone 4: learned preferences

- Local historical import with progress and deletion controls.
- Explainable preference rules and confidence calibration.
- Learning from proposal outcomes and owner draft edits.
- `why this?`, correction, and preference deletion flows.

### Milestone 5: optional connectors

- Connector contract for evidence-only MCP sources.
- Per-source OAuth, scopes, privacy policy, and capability declarations.
- Connectors graduate to proposal-producing actions only after they satisfy the
  same approval and verification contract as Gmail and Calendar.

## Acceptance criteria

- A normal process restart outside the catch-up window does not create a daily
  briefing. A missed window inside six hours produces one briefing or a
  visibly-labelled retry when delivery was uncertain.
- A new important email can produce a proposal; a routine email waits for the
  daily review.
- An urgent email that needs a question interrupts before preference learning;
  a routine email waits for the daily review.
- Approving an email creates a Gmail draft and never sends mail, including from
  the ad-hoc email flow.
- Pingu explains the evidence and confidence for a recommendation on request.
- Ignoring or deferring an item changes later recommendations predictably.
- A calendar proposal lists every affected event and maintains declared
  dependency order.
- A stale calendar plan cannot overwrite a newly changed event.
- Any failed provider operation is reported clearly and is never described as
  complete.
- Resetting runtime data removes decision and Gmail-history state without
  removing credentials.
- Owner history and learned preferences remain local and are absent from public
  source, tests, fixtures, and documentation examples.
