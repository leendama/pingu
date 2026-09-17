# Assistant roadmap status

## Reliability foundation

Implemented: durable task checkpoints, proposal execution claims, interrupted-action detection, and approval payload snapshots. An approval is checked against the payload captured for its delivered briefing inside the execution-claim transaction. Explicit owner edits replace only the reviewed draft body and its snapshot.

Gmail creation timeouts, missing creation IDs, failed verification, and mismatched read-back are uncertain outcomes. They are held as `partially_completed`; the same source action cannot be reclaimed through another proposal. Known draft IDs are retained. Calendar move requests whose responses are lost are also held, even when earlier acknowledged moves were rolled back. A later bookkeeping failure cannot downgrade a completed execution claim.

Migration to ledger version 4 intentionally leaves old briefing snapshots empty. Old numbered approvals require a fresh briefing: the reviewed payload cannot safely be reconstructed from current data. Back up the ledger before upgrading; older binaries cannot open version 4.

Remaining: automated reconciliation of uncertain provider outcomes and task resumption across crashes. Checkpoint recording still depends on tool use by the model. Regression tests verify state transitions, not real-world assistant quality. Duplicate suppression lasts for retained ledger records; retention cleanup is not a permanent provider idempotency guarantee.

## Remaining stages and dependencies

| Stage | Current state | Next implementation and acceptance checks |
| --- | --- | --- |
| Read-only web research | Implemented for the OpenAI endpoint; live quality evaluation remains | Hosted search and page research preserve source citations and retrieval timestamps, bound requests, and isolate third-party content. Offline tests cover missing evidence, failed requests, page-open checks, and write isolation. Evaluate real answers against dated, conflicting, and inaccessible sources before calling this stage validated. |
| Background workflows | On-demand workflows exist; general scheduled runner does not | Build durable run records, checkpoints, leases, cancellation, bounded retries, and delivery deduplication. Test restarts at every write/delivery boundary. Depends on reconciliation above. |
| Commitments and source retrieval | Basic follow-up tracking and Markdown search exist | Add source-linked commitment lifecycle and stronger retrieval. Evaluate missed obligations, false obligations, stale commitments, and citation accuracy against labelled fixtures. |
| Browser actions | Not implemented | Route proposed submissions through reviewed action snapshots, revalidate the page before execution, and reconcile uncertain submissions. Depends on reliable execution and source isolation; test changed pages, expired approval, and lost responses. |

Each stage needs its own end-to-end evaluation before enabling it. Passing unit tests alone does not establish that the assistant reliably chooses the right action.
