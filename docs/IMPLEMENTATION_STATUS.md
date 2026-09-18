# Assistant roadmap status

## Reliability foundation

Implemented: durable task checkpoints, proposal execution claims, interrupted-action detection, and approval payload snapshots. An approval is checked against the payload captured for its delivered briefing inside the execution-claim transaction. Explicit owner edits replace only the reviewed draft body and its snapshot.

Gmail creation timeouts, missing creation IDs, failed verification, and mismatched read-back are uncertain outcomes. They are held as `partially_completed`; the same source action cannot be reclaimed through another proposal. Known draft IDs are retained. Calendar move requests whose responses are lost are also held, even when earlier acknowledged moves were rolled back. A later bookkeeping failure cannot downgrade a completed execution claim.

Migration to ledger version 4 intentionally leaves old briefing snapshots empty. Old numbered approvals require a fresh briefing: the reviewed payload cannot safely be reconstructed from current data. Back up the ledger before upgrading; older binaries cannot open version 4.

Implemented next: read-only reconciliation for identifiable Gmail drafts and verifiable calendar moves, plus checkpointed background workflow runs. Unidentifiable or conflicting outcomes remain held. Checkpoint recording still depends on tool use by the model. Regression tests verify state transitions, not real-world assistant quality. Unresolved uncertain actions now survive retention cleanup. Completed-action deduplication still lasts only for retained ledger records; it is not a permanent provider idempotency guarantee.

## Remaining stages and dependencies

| Stage | Current state | Next implementation and acceptance checks |
| --- | --- | --- |
| Read-only web research | Implemented for the OpenAI endpoint; live quality evaluation remains | Hosted search and page research preserve source citations and retrieval timestamps, bound requests, and isolate third-party content. Offline tests cover missing evidence, failed requests, page-open checks, and write isolation. Evaluate real answers against dated, conflicting, and inaccessible sources before calling this stage validated. |
| Background workflows | Implemented for explicitly scheduled read-only workflows | Durable run records, completed-read-round checkpoints, lease fencing, cancellation, bounded retries, and held uncertain deliveries are covered by offline tests. Live synthesis quality and wall-clock recurring schedules remain to be evaluated or added. See [background workflows](BACKGROUND_WORKFLOWS.md). |
| Commitments and source retrieval | Basic follow-up tracking and Markdown search exist | Add source-linked commitment lifecycle and stronger retrieval. Evaluate missed obligations, false obligations, stale commitments, and citation accuracy against labelled fixtures. |
| Browser actions | Not implemented | Route proposed submissions through reviewed action snapshots, revalidate the page before execution, and reconcile uncertain submissions. Depends on reliable execution and source isolation; test changed pages, expired approval, and lost responses. |

Each stage needs its own end-to-end evaluation before enabling it. Passing unit tests alone does not establish that the assistant reliably chooses the right action.

## Gmail scanner health

Transient failures retry silently for three minutes. Both whole-mailbox failures and queued message reviews use the same persisted incident clock; restarting does not reset that grace period. A sustained delay uses the existing single-incident owner warning. Whole-mailbox retries are capped at five minutes, while individual failed messages retain durable exponential retries. A warning delivery failure does not prevent queue persistence or turn a healthy scan into a failed one.

The ledger metadata key `chief-of-staff:gmail-health` records the last successful mailbox scan, last fully healthy scan, queued-review count, and whether the delay is at the mailbox or message-review stage. These are operational diagnostics, not email content. A successful mailbox scan alone does not count as full recovery while reviews remain queued.
