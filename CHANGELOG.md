# Changelog

## 0.1.0

First public release.

### Who can text

- Anyone can text the number. The owner proves identity by texting a claim code from the setup page or `npm run claim`; the exact sender id Spectrum reports is recorded. A typed phone number is never enough, and a message with no sender is treated as a guest.
- Private Gmail, Calendar, and Granola tools exist only in the verified owner's direct messages. The model never sees them for guests or groups.
- Guests get a first-contact introduction, ordinary chat, reminders, and scheduling. Per-sender daily message caps, a global daily token budget, and a reminder cap protect the model bill.

### Guest scheduling

- Free windows for a day, in the guest's timezone, inside the owner's bookable hours (default 09:00 to 17:00 weekdays), with buffers and minimum notice, at most five, never with event details.
- Meeting requests with a name, purpose, and unverified email. The owner approves by replying yes to the request text. Pingu rechecks the slot, creates the event with a Google Meet link, emails the invite, verifies the event, and tells both people.
- Requests expire after 24 hours. Guests can cancel their own booking; the owner is told.

### Memory and providers

- Conversation history now lives in local per-chat transcripts with retention and compaction, replacing OpenAI's hosted conversation objects. Old conversation ids are dropped on first start.
- `OPENAI_BASE_URL` points Pingu at any OpenAI Responses-compatible endpoint that supports function calling. OpenAI, Ollama, and LM Studio are tested. The endpoint is probed before Pingu starts; voice replies exist only with OpenAI.
- Spectrum SDK telemetry is off unless enabled.
- "Forget this conversation" and "Delete all Pingu data" actions.

### Safety

- Deleting a recurring event, an event with other attendees, or several events at once asks for the owner's yes. A single personal event still deletes in one step.
- Content read from email or meeting notes never authorises a deletion in the same turn.
- Calendar creates, edits, deletes, and bookings are read back from Google before success is reported.

### Setup

- The wizard shows the claim code, lists verified owners, and has settings for the model endpoint, bookable hours, guest caps, retention, and telemetry.
- `npm run doctor` runs the provider capability probe and warns about Google OAuth apps left in Testing mode.
