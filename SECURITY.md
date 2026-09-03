# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for credential exposure, authentication bypass, and privacy issues. Include the affected version, impact, and a small reproduction. Remove API keys, OAuth tokens, email, calendar, and message content from the report.

## Security model

- Each installation supports one owner's accounts. Anyone can text the number.
- The owner is whoever texted an active claim code. Pingu records the exact sender id Spectrum reports, never a number typed into settings. `PINGU_OWNER_SENDER_IDS` can add ids you already know. A message with no sender id is treated as a guest.
- Private Gmail, Calendar, and Granola tools are offered to the model only in a verified owner's direct message. In groups and for guests they are absent from the tool list, and a direct call is refused.
- Guests can see free windows inside the bookable hours, request a meeting, and cancel their own booking. Nothing is booked until the owner replies yes; the slot is rechecked at approval. Guest text is sanitised and capped before it reaches a calendar field.
- Email sending requires a stored pending draft and a separate explicit confirmation message. Direct send is not registered as a model tool.
- Deleting a recurring event, an event with other attendees, or several events at once requires a separate explicit confirmation.
- Once a turn has read email or meeting notes, every side-effecting tool is refused for the rest of that turn except creating a review-only draft, because third-party content never authorises a write. The owner repeats the request as a fresh message.
- Every calendar write, including guest bookings, is read back and compared field by field with the request before success is reported.
- Group rename and membership changes are owner-only. Reminders belong to their creator; nobody else can list or cancel them.
- Per-sender daily message caps, a reserved-before-admission global daily token budget, an inbound size limit, and a claim-attempt limit bound what unknown senders can cost or provoke.
- Booking state moves through claimed transitions (pending to approving, booked to cancelling) held in a single store transaction, and a guest is told a request was sent only when an owner chat received it.
- Configuration and Google refresh tokens saved by the hosted setup wizard are encrypted at rest with AES-256-GCM. Local `.env` and desktop OAuth files rely on operating-system file protections. Transcripts and other state are written with owner-only permissions.
- `PHOTON_CONFIG_KEY` and `PHOTON_SETUP_TOKEN` must be separate random host secrets and are never stored in the encrypted document. Serve the wizard over HTTPS; its session cookie is marked Secure only then.
- Plugin tools are private and side-effecting by default. Plugins are trusted server code; review them before installation.

Access to the host environment, persistent disk, Photon project, or setup token can expose private data. Use MFA, limit collaborators, rotate exposed keys, and keep dependencies updated.

## Known dependency advisories

`npm audit --omit=dev` on this release reports moderate findings in two areas. Compatible updates have been applied where they exist (`qs` under Express and the Google APIs client is current).

- **OpenTelemetry** (`@opentelemetry/core` below 2.8.0, an unbounded-memory advisory), pulled in by `spectrum-ts@12.8.x`. The automated fix installs an incompatible Spectrum version. Keep the pinned version and check Photon releases for a compatible update. Pingu leaves Spectrum telemetry off unless you opt in, so the affected exporter code path is not exercised by default.
- **uuid** (below 11.1.1, a buffer bounds check in v3/v5/v6 when a buffer is supplied), pulled in by `gaxios` under the Google APIs client. Pingu does not use the uuid package itself; it generates ids with `node:crypto`. The fix requires a major version of `gaxios` that the current Google client does not accept.

Re-run `npm audit --omit=dev` before each release and update this list.
