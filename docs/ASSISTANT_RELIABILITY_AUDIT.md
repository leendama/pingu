# Assistant reliability audit

Reviewed 14 September 2026. Scope: date handling, short follow-ups, notification usefulness, response style, and comparable open-source assistant policies. Private transcripts and account data are excluded from this document.

## Findings and implementation

The date failure comes from stale temporal context: an earlier clock tool result stays in history, while the next turn previously received no refreshed local date. This can produce a correct absolute booking with an incorrect relative label, followed by a destructive correction and a conflict lookup on the wrong day. Calendar overlap arithmetic already compares absolute intervals; loosening it would hide the cause.

Implemented in this checkout:

- A runtime-owned clock with explicit local calendar date, timezone and UTC timestamp is appended to every model request, including tool rounds and retries. It refreshes across midnight and daylight saving changes.
- Historical clock results are labelled as earlier observations in the model projection. Stored transcripts remain intact.
- The clock tool accepts null for the configured timezone, avoiding unnecessary timezone selection by the model.
- Calendar instructions preserve explicit past dates, retain the active task when a short reply supplies duration/time, and require reading the actual event before correcting it. Correct bookings should survive incorrect wording; incorrect bookings should be moved rather than deleted first.
- Create, edit and move conflict failures provide the requested interval and the conflicting event's full dates and timezone. Real overlaps remain blocked.
- Conversational style is supplied through an external private plugin. Names, URLs, quotations, code and professional drafts retain their original register and spelling.

Earlier local fixes already cover short-reply proposal routing, oversized tool-history compaction, stale email suppression, small actionable briefings and uncertain-delivery suppression. The current work builds on those changes.

## Comparison and decisions

These are source-level comparisons, not comparative model benchmarks. Upstream main branches can change.

| Project | Observed mechanism | Pingu decision |
| --- | --- | --- |
| [OpenClaw system prompt](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md) | Separate temporal context includes user-local date and timezone; exact time remains tool-accessible. Prompt snapshots and context diagnostics expose prompt drift and truncation. Tool policy supplies enforcement beyond prompt advice. | Adopt fresh temporal context now. Next add privacy-preserving context-size and compaction diagnostics plus prompt snapshots. Keep permission and overlap checks in code. |
| [nanobot context builder](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/context.py) | Separates stable identity, user files, memory and archived summaries from the fresh turn. | Keep personal style outside public code. Prioritise a bounded active-task summary with retained event IDs/date constraints before increasing history limits. |
| [nanobot settings](https://github.com/HKUDS/nanobot/blob/main/nanobot/config/schema.py) | Exposes model presets, temperature, output/context budgets, reasoning effort, tool-result limits and iteration limits. Inspected defaults include temperature 0.1, 8,192 output tokens, 16,000 tool-result characters and 200 tool iterations. | Do not copy these values into an iMessage assistant. Pingu currently uses low reasoning and low verbosity when supported, six owner tool rounds, and 60,000 history characters. Keep these for this fix; evaluate configurable per-task reasoning and result-size limits separately. A small output cap can truncate useful tool arguments or draft reviews. |
| [Letta Code prompt](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md) | Separates recall history from concise editable memory blocks and external memory; documents when memory changes reach the model. | Preserve explicit preferences separately from transient facts. Add task-state recall before broader automatic memory learning. Do not turn an old clock or email snapshot into a lasting fact. |

## Ordered next improvements and evaluation gates

1. **Active task state and recall.** Persist requested date, timezone, affected event IDs, pending question and completion status. Depends on identifying task boundaries and correcting state when users change plans. Evaluate short replies, topic switches, midnight follow-ups and interrupted turns. Never let an unrelated yes authorise a proposal.
2. **Context diagnostics and bounded tool results.** Log counts, sizes, truncation and retry categories without message bodies or credentials. Depends on preserving tool-call/output pairs and keeping identifiers needed for follow-ups. Evaluate oversized calendars and draft bodies before changing limits.
3. **Configurable reasoning profiles.** Compare the existing low-effort setting with a higher-effort planning profile using synthetic calendars. Gate on wrong-day rate, extra questions, mutation count, task completion, latency and token cost. Keep simple confirmations short. No model or temperature change is justified by source inspection alone.
4. **Scenario-level model evaluations.** Use sandbox calendar ports and synthetic mailboxes for multi-turn scenarios. Include wording-only corrections, explicit past events, genuine conflicts, wrong-day conflicts, two-lessons-per-day answers, stale mail and uncertain delivery. Require no duplicate mutation or unwanted send. The current automated suite is offline regression testing, not evidence that the model can never misinterpret a request.

## Validation and repository scope

Added deterministic tests for local/UTC date disagreement, midnight refresh, daylight saving, configured clock timezone, historical-clock projection, past calendar creation on the exact date, and full-date conflict evidence. Existing suites cover verified calendar writes, move rollback, transcript continuity and chief-of-staff freshness.

No new dependencies or model parameters are required. The local working branch diverges from origin/main (8 upstream-only and 11 local-only commits at review time) and contains ongoing changes. Upstream was fetched and inspected; no merge, reset or publication was performed. Private style configuration is not part of the public diff.
