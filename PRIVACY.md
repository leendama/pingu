# Privacy

Pingu is self-hosted. This page says exactly what stays on your machine, what leaves it, who can see what, and how to delete it.

## What stays on your machine

Everything under `PHOTON_DATA_DIR` (default `data/`):

- Chat transcripts, one file per conversation, including tool calls and their results.
- Reminders, email alerts, pending email drafts, pending delete confirmations.
- Guest counters (per-sender daily message counts and the global daily token total).
- Verified owner ids and the active claim code.
- Meeting requests, their approvals, expiry, and outcomes.
- The encrypted configuration and Google tokens.

Files are written with owner-only permissions. Transcripts are trimmed to the retention window (`PINGU_TRANSCRIPT_RETENTION_DAYS`, default 30 days) and to a size cap on every write.

## What leaves your machine

- **Photon.** Every iMessage in and out is relayed by Photon's service. Photon sees message text, sender ids, and chat ids. Spectrum SDK telemetry is off unless you turn it on.
- **Your model provider.** Each turn sends the system instructions, the conversation transcript for that chat, and the results of any tools the model called. With OpenAI that includes calendar events, email bodies, or meeting notes the model asked for. Pingu sends OpenAI requests with `store: false`. With Ollama or LM Studio, that traffic stays on your hardware.
- **Google.** Calendar and Gmail calls go to Google with your OAuth token.
- **Granola.** Note reads go to Granola with your API key.

Pingu itself has no server and collects nothing.

## What a guest can learn

Anyone can text the number. A guest sees:

- A one-line introduction saying Pingu is your assistant and what it can do for them.
- Up to five free windows on a day they ask about, inside your bookable hours, at least the minimum notice ahead. Never event titles, attendees, locations, counts, or reasons.
- The outcome of their own meeting request or cancellation.
- Ordinary chat and reminders, within daily limits.

A guest cannot reach Gmail, Granola, or any calendar tool other than availability. The tools are absent from the model's tool list for guests, not merely refused. Free windows alone reveal patterns, such as a standing weekly appointment, so keep bookable hours to the times you would tell a stranger.

## What you, the owner, are shown about guests

The sender id Spectrum reports, the name and purpose they typed, and the email they supplied, marked unverified. Guest text is stripped of control characters and capped before it reaches your calendar.

## Deleting data

- Ask Pingu to forget the current chat.
- Delete everything Pingu remembers: `npm run reset-data -- --yes`, or the **Delete all Pingu data** button on the setup page. Transcripts, reminders, alerts, drafts, guest records, verified owners, and booking requests are removed. Credentials are kept so you are not signed out.
- Retention also runs on its own: entries older than the retention window are removed from disk when a chat is read and by a cleanup pass every six hours, so a chat that never gets another message still expires.

Credentials live in different places depending on how you set Pingu up:

| Setup | Where credentials are | How to remove them |
|---|---|---|
| Browser wizard (Docker or hosted) | `config.enc.json` inside `PHOTON_DATA_DIR`, encrypted with `PHOTON_CONFIG_KEY` | Remove `PHOTON_DATA_DIR` (or the `pingu-data` volume) and forget `PHOTON_CONFIG_KEY` |
| Local `.env` on a Mac | `.env` in the project folder, `credentials.json` (or `GOOGLE_CREDENTIALS_PATH`), and `google-token.json` inside `PHOTON_DATA_DIR` | Delete `.env` and `credentials.json` yourself; removing `PHOTON_DATA_DIR` drops only the token |

Owner ids listed in `PINGU_OWNER_SENDER_IDS` keep granting owner access after any reset, because they live in your environment, not in the data directory. Remove them from `.env` or the host configuration to revoke them.

Revoke Google access at any time from your Google account's third-party access page.
