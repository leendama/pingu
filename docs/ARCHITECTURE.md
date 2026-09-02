# Architecture

- `src/index.ts` starts the app.
- `src/bootstrap.ts` loads typed settings or starts the browser wizard, and reports real startup outcomes.
- `src/agent.ts` probes the model endpoint, wires Spectrum, the registry, schedulers, and conversation queues, and frames every model turn by audience (owner, guest, group).
- `src/provider.ts` builds the model client for OpenAI or an OpenAI Responses-compatible endpoint and proves what it supports: model listing, a plain response, a function call, tool continuation, reasoning parameters. Voice is derived from the provider kind.
- `src/reply-generator.ts` owns the stateless model call loop over a local transcript, and one-shot recovery by forgetting the chat, testable without live accounts.
- `src/transcripts.ts` keeps one history file per chat with retention and compaction that always cuts at a user message, plus the delete-all action.
- `src/message-pipeline.ts` handles one incoming message: sender id, claim codes, role, guest admission and disclosure, owner replies to booking requests, confirmations, then the model.
- `src/owners.ts` records verified owners by exact sender id and issues the claim codes that verify them. A missing sender is a guest.
- `src/guests.ts` counts guest messages per sender and per day, tracks the global token budget, and holds the first-contact line.
- `src/plugins.ts` is the only dispatch path. Tools start as private and side-effecting; the registry filters the tool list by audience so a hidden tool is never offered to the model, and marks a turn once a tool returned third-party content.
- `src/tools.ts` keeps each tool schema, privacy rule, audience, retry rule, and executor together.
- `src/capabilities/` contains Calendar, Gmail, Granola, reminder, email-alert, clock, iMessage, privacy, and guest-scheduling tools.
- `src/scheduling.ts` is the guest booking state machine: bookable windows, requests, owner approval by reply, recheck on approve, verified booking, expiry, and guest cancellation. State lives in `scheduling-requests.json`, never in chat memory.
- `src/pending-confirmations.ts` arms a destructive action (recurring, attendee, or bulk deletes) that fires only on an explicit yes in the next message; email drafts use the same pattern in `src/pending-emails.ts`.
- `src/state.ts` provides serialized atomic JSON storage for every data file. One process per data directory.
- `src/email-alerts.ts` stores Gmail sender rules and polls for new matching messages while Pingu is running.
- `src/poller.ts` is the one background tick loop the reminder, email-alert, and request-expiry schedulers share.
- `src/diagnostics.ts` tests every probeable connection and reports plain-language failures; the wizard's "Test connections" button and `npm run doctor` both cross this one interface.
- `src/runtime-status.ts` records when the agent started and last replied; the wizard and `/healthz` read it as proof of life.
- `src/setup-server.ts` handles browser setup, Google OAuth, claim codes, owner removal, and data deletion.
- `src/config.ts` encrypts credentials saved through the browser wizard. `src/runtime-settings.ts` resolves settings from the wizard or the environment once and passes them into the agent.

Messages stay in order within each conversation. Messages received within a short burst are combined into one ordered request so every fragment is preserved. Threaded iMessage replies include both the referenced message and the new reply. Separate conversations run at the same time. Model recovery stops when an action begins, and every calendar write is read back before success is reported. This protects against duplicate events, emails, reminders, bookings, and messages.
