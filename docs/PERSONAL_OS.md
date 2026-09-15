# Personal OS support

Pingu can keep unfinished task context, track evidence-backed follow-ups, and retrieve private Markdown notes. These capabilities are available only in the verified owner's direct messages. They do not let guests read the owner's notes or obligations.

## Configuration

Set `PINGU_VAULT_PATH` in the runtime environment to an existing Obsidian vault to enable `search_personal_brain`, `read_personal_note`, and `capture_personal_note`. The path and all personal content belong in private runtime configuration, outside this repository. No new dependency or embedding service is required.

Search reads visible Markdown files, skips symlinks and hidden directories, and returns up to eight keyword candidates with source links. It scans at most 3,000 files and reports when its scan is limited. Read the candidate note before claiming a relationship. Retrieval is not semantic proof that people, projects, or lessons are connected.

Captures create new, unreviewed inbox notes only. They never overwrite an existing note or promote a principle. Unrecorded conversations carry an explicit recollection label. Source summaries and recollections remain distinct.

## Tasks and follow-ups

Before asking a multi-step clarification, the assistant is instructed to save a task checkpoint: question, constraints, explicit dates, source IDs, and remaining work. Active checkpoints are supplied on subsequent owner turns independently of transcript truncation. The model still has to choose the right checkpoint and verify tool results; a checkpoint is never action authorization.

Terminal model failures preserve the inbound request and only the tool calls actually attempted, with observed results or an unknown-outcome marker. This provides evidence for a subsequent “why?” without automatically repeating an uncertain write.

The existing chief-of-staff scanner records actionable email reply requests in a durable thread-level list. It keeps its current alert freshness, classification, and deduplication rules. Repeated scans do not reopen dismissed items; a newer actionable message does. Existing mailbox history is not automatically backfilled.

Each minute, a separate silent reconciliation checks up to 20 pending threads per owner, rotating through older checks first. A later SENT message marks the reply request `reply_sent`. Drafts and read failures do not close it. Sending a reply is not evidence that every promise in its body has been completed. Other explicit commitments can be recorded separately with who owes the action and its source.

State is stored in `PHOTON_DATA_DIR/personal-state.json`. “Forget this conversation” clears its task and commitment records as well as chat history. Removing the owner clears their state. Vault notes remain in the vault. Unlike transcript retention, active commitments persist until explicitly closed or forgotten.

## On-demand workflows

Ask naturally or run one of the built-in workflows:

- **meeting prep**: last relevant conversation, unresolved question or promise, and one suggested useful meeting outcome; target at most 100 words with sources.
- **meeting follow-through**: explicit decisions, attributed follow-ups, open questions, and at most two supported principle/lesson connections; target at most 150 words.
- **direction review**: read current written priorities first, compare recent evidence, identify uncertainty, and suggest one small next step; target at most 180 words.

These are read-only workflows, with tool restrictions enforced by the registry. They run only when requested. No new notification schedule, message delivery, booking, or automatic promotion of observations is created. Source-dependent workflows have up to ten tool rounds; ordinary owner chat keeps six and guests retain their configured limits. Word targets and evidence interpretation are model instructions, not deterministic guarantees.

## Validation

Regression coverage includes lost responses after writes, unexecuted calls, persistent clarification context, owner isolation, thread replay/dismissal, sent-versus-draft distinction, a new inbound email racing with reconciliation, path traversal and symlinks, idempotent recollection capture, and read-only workflow enforcement. Run `npm run check`.
