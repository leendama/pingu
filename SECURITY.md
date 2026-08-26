# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for credential exposure, authentication bypass, and privacy issues. Include the affected version, impact, and a small reproduction. Remove API keys, OAuth tokens, email, calendar, and message content from the report.

## Security model

- Each installation supports one owner and one set of integrations.
- Configuration and Google refresh tokens saved by the hosted setup wizard are encrypted at rest with AES-256-GCM. Local `.env` and desktop OAuth files rely on operating-system file protections.
- `PHOTON_CONFIG_KEY` and `PHOTON_SETUP_TOKEN` must be separate random host secrets and are never stored in the encrypted document.
- The setup wizard keeps saved secrets hidden.
- Private Gmail, Calendar, and Granola tools are blocked in group chats.
- Email sending requires a stored pending draft and a separate explicit confirmation message. Direct send is not registered as a model tool.
- Plugin tools are private and side-effecting by default. Plugins are trusted server code; review them before installation.

Access to the host environment, persistent disk, Photon project, or setup token can expose private data. Use MFA, limit collaborators, rotate exposed keys, and keep dependencies updated.

## Known dependency advisory

npm reports a moderate unbounded-memory advisory in an OpenTelemetry package used by `spectrum-ts@12.8.x`. The automated fix installs an incompatible Spectrum version. Keep the pinned version and check Photon releases for a compatible update.
