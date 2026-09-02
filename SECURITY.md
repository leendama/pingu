# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for credential exposure, authentication bypass, and privacy issues. Include the affected version, impact, and a small reproduction. Remove API keys, OAuth tokens, email, calendar, and message content from the report.

## Security model

- Each installation supports one owner's accounts. Anyone can text the number.
- The owner is whoever texted an active claim code. Pingu records the exact sender id Spectrum reports, never a number typed into settings. `PINGU_OWNER_SENDER_IDS` can add ids you already know. A message with no sender id is treated as a guest.
- Private Gmail, Calendar, and Granola tools are offered to the model only in a verified owner's direct message. In groups and for guests they are absent from the tool list, and a direct call is refused.
- Guests can see free windows inside the bookable hours, request a meeting, and cancel their own booking. Nothing is booked until the owner replies yes; the slot is rechecked at approval. Guest text is sanitised and capped before it reaches a calendar field.
- Email sending requires a stored pending draft and a separate explicit confirmation message. Direct send is not registered as a model tool.
- Deleting a recurring event, an event with other attendees, or several events at once requires a separate explicit confirmation. Any turn that read email or meeting notes requires that confirmation for every delete, because third-party content never authorises a write.
- Every calendar write is read back before success is reported.
- Per-sender daily caps and a global daily token budget bound what unknown senders can cost.
- Configuration and Google refresh tokens saved by the hosted setup wizard are encrypted at rest with AES-256-GCM. Local `.env` and desktop OAuth files rely on operating-system file protections. Transcripts and other state are written with owner-only permissions.
- `PHOTON_CONFIG_KEY` and `PHOTON_SETUP_TOKEN` must be separate random host secrets and are never stored in the encrypted document. Serve the wizard over HTTPS; its session cookie is marked Secure only then.
- Plugin tools are private and side-effecting by default. Plugins are trusted server code; review them before installation.

Access to the host environment, persistent disk, Photon project, or setup token can expose private data. Use MFA, limit collaborators, rotate exposed keys, and keep dependencies updated.

## Known dependency advisory

npm reports a moderate unbounded-memory advisory in an OpenTelemetry package used by `spectrum-ts@12.8.x`. The automated fix installs an incompatible Spectrum version. Keep the pinned version and check Photon releases for a compatible update.
