# Architecture

- `src/index.ts` starts the app.
- `src/bootstrap.ts` loads typed settings or starts the browser wizard.
- `src/agent.ts` wires Spectrum, OpenAI, reminders, plugins, and conversation queues.
- `src/message-pipeline.ts` handles one incoming message and email review delivery.
- `src/capabilities/` contains Calendar, Gmail, Granola, reminder, clock, voice, and iMessage tools.
- `src/tools.ts` keeps each tool schema, privacy rule, retry rule, and executor together.
- `src/plugins.ts` is the only dispatch path. Tools start as private and side-effecting.
- `src/state.ts` provides serialized atomic JSON storage for conversations, pending emails, reminders, and encrypted setup.
- `src/email-alerts.ts` stores Gmail sender rules and polls for new matching messages while Pingu is running.
- `src/setup-server.ts` handles browser setup and Google OAuth.
- `src/config.ts` encrypts credentials saved through the browser wizard.
- `src/runtime-settings.ts` resolves settings once and passes them into the agent and adapters.

Messages stay in order within each conversation. Messages received within a short burst are combined into one ordered request so every fragment is preserved. Threaded iMessage replies include both the referenced message and the new reply. Separate conversations run at the same time. OpenAI conversation recovery stops when an action begins. This protects against duplicate events, emails, reminders, and messages.
