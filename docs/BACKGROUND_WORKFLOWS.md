# Background workflows and action recovery

## Explicit scheduling

The owner can ask to run a saved or built-in read-only workflow later, or repeatedly. For example: “run meeting prep tomorrow at 8am for the meeting with the product team.” Pingu resolves the time, snapshots the workflow and specific request, and confirms the schedule. No schedule is created by installing this feature.

Tools: `schedule_workflow`, `list_workflow_runs`, and `cancel_workflow_run`. These are private to owner direct messages. Scheduling requires a future ISO timestamp with a UTC offset, within 90 days. Repeats are either disabled or fixed intervals of 24–168 hours; they do not preserve local wall-clock time across daylight-saving transitions. Cancellation stops the series and invalidates in-flight research; a delivery already in progress cannot be recalled. Editing a saved workflow does not change an existing schedule: cancel and reschedule to approve the new definition.

The runtime polls every minute while the host is awake. This is not an always-on hosting service. Jobs over six hours late are marked missed; recurring jobs skip to the next future occurrence instead of delivering a backlog. At most ten active runs may be scheduled per owner. Check status and saved results through the listing tool, including failures and uncertain deliveries.

## Durable execution

Runs live in `PHOTON_DATA_DIR/workflow-runs.sqlite`. SQLite transactions claim work using unique lease tokens. A ten-minute expired research lease can be reclaimed; an old worker cannot save over its replacement. Read-only research retries at most three times. The configured model receives only the snapshotted job and source evidence, not the chat transcript. The registry enforces the approved read-tool list and rejects undeclared writes even if the model requests them.

Checkpoints retain completed read rounds (at most six model rounds, twelve reads, and 100,000 characters of saved state). Requests use 45-second model timeouts and 30-second read waits. A timed-out read may continue in its provider client, but its result cannot trigger a write. A process interruption within an unfinished round may repeat reads, never a mutation. A saved result clears its evidence checkpoint.

Generation and delivery are separate states. The result is saved before sending. A durable delivery claim is written before the send begins. A thrown send or expired delivery lease becomes `delivery_unknown` and is not automatically resent. This deliberately prefers an inspectable held result over duplicate notifications; it is not an exactly-once delivery guarantee. Results and terminal history expire after 30 days. Forgetting a conversation or removing its owner clears that owner's runs and future schedules. Full data reset clears this database through its live connection as well. The latest three delivered or delivery-unknown results are included as labelled reference context on later owner turns, so a follow-up can refer to the scheduled output without treating it as action authorization.

## Read-only reconciliation

Approved Gmail drafts now receive a unique RFC Message-ID derived from the proposal ID. Gmail's [draft query API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list) supports finding that marker. After an uncertain action, Pingu uses the known draft ID when available, otherwise the unique marker. It requires one matching draft and verifies recipients, subject, body, and thread before completing the ledger action.

Calendar move recovery reads every requested event and verifies the requested start/end instants. Plans involving duplicate deletion remain held because a missing read is insufficient deletion evidence. Mixed moves, changed drafts, missing results, multiple matches, unavailable providers, and legacy drafts without an ID or marker remain uncertain. No recovery path repeats creation, movement, or deletion. Revoked owners' sources are not read.

Recovery checks up to ten uncertain proposals each minute, with a five-minute per-proposal minimum and rotation across proposals. Unresolved uncertain actions and their claims survive ordinary retention cleanup. Successful reconciliation updates the proposal and duplicate-execution claim together. Reconciliation is quiet; current proposal state reflects the result.

## Verification limits

Offline tests cover claims across SQLite connections, lease expiry, checkpoint continuation, cancellation, owner revocation, retry limits, offline catch-up, uncertain delivery, source-injection write blocking, and Gmail/Calendar reconciliation. They do not establish live model synthesis quality. No real messages, drafts, or calendar changes are created by the tests. Browser actions and richer commitment retrieval remain separate roadmap work.
