# Setup

Pingu is guided self-hosting: a few commands, a browser wizard, and one Google Cloud walkthrough. It is not one-click, and this page does not pretend otherwise.

## Run it on your Mac

You need Node.js 22 or newer.

1. Create a Photon Spectrum project at [app.photon.codes](https://app.photon.codes).
2. Connect an iMessage line to the project.
3. Create an OpenAI API key, or run a local model (see "Use a local model").
4. Copy `.env.example` to `.env`.
5. Add your Photon project ID, Photon secret, and OpenAI key to `.env`.
6. Install and start the assistant:

```bash
npm install
npm run start
```

## Prove you are the owner

Anyone can text your Pingu number. Until you claim it, every sender is a guest and private tools stay off.

```bash
npm run claim
```

Text the printed code (for example `PINGU-4F7K2Q`) to your Pingu number from your own phone within an hour. Pingu replies "Verified" and records the exact sender id Spectrum reports. Typing a phone number into a settings file is deliberately not enough: ids are opaque, and a claim proves you hold the phone.

Repeat from another device to verify a second handle. Remove a handle from the setup page, or by deleting it from `owners.json` in the data directory.

## Connect Google Calendar and Gmail

1. Open [Google Cloud](https://console.cloud.google.com) and create or pick a project.
2. Enable the **Google Calendar API** and the **Gmail API**.
3. Configure the OAuth consent screen. Add your own Google account as a test user.
4. Create an OAuth client. On a Mac use the **Desktop** type; for the browser wizard use the **Web** type and add the redirect URI the wizard shows.
5. Download the client file and save it as `credentials.json` in the project folder (or set `GOOGLE_CREDENTIALS_PATH`).
6. Run:

```bash
npm run connect:google
```

Your browser opens for approval. The token is saved in `data/google-token.json`.

**The seven-day trap.** While the OAuth app's publishing status is **Testing**, Google expires every sign-in after seven days and Pingu will report "The Google sign-in is no longer valid" each week. Set the app to **In production** on the consent screen. You do not need Google verification for your own use; Google shows an "unverified app" screen once during sign-in, which is fine.

Guest bookings add a Google Meet link by default. That uses the same calendar permission; no extra scope is needed.

## Use a local model

Set `OPENAI_BASE_URL` to an OpenAI Responses-compatible endpoint that supports function calling, and `OPENAI_MODEL` to a model that supports tools:

| Provider | Base URL | Notes |
|---|---|---|
| OpenAI | leave blank | Default. The only provider with voice replies. |
| Ollama | `http://localhost:11434/v1` | Pick a tool-capable model. Ollama's Responses endpoint is stateless, which is fine: Pingu keeps history locally. |
| LM Studio | `http://localhost:1234/v1` | Enable the server in LM Studio. |

Pingu probes the endpoint before it starts: model listing, a plain response, a function call, continuing after a tool result, and the reasoning parameters. `npm run doctor` shows the same probe. An endpoint that cannot call tools is refused with the reason.

Topology matters:

- Inside Docker, `localhost` means the container. A model on the Mac that runs Docker is `http://host.docker.internal:11434/v1`.
- A Pingu on a cloud host cannot reach a model on a laptop that is asleep or switched off. Run the model where Pingu runs, or use OpenAI.

## Check your setup

Before starting the assistant, or whenever something misbehaves:

```bash
npm run doctor
```

It tests every connection it can reach: the model endpoint and its capabilities, the Google sign-in and its calendar and Gmail permissions, and the Granola key, and says in plain language what is wrong with any that fail. Photon credentials are verified when the assistant starts; the final proof is Pingu replying to a text.

In the browser wizard, the **Test connections** button runs the same checks. Once the assistant is running, the setup page also shows when Pingu last replied to a message.

To keep Pingu running on a Mac across logouts and reboots, create a LaunchAgent that runs `npm run start` in this folder, or use the Docker option below.

## Run with Docker Compose

Check out a release so the image you build is reproducible:

```bash
git fetch --tags
git checkout v0.1.0
docker compose up -d
```

This builds the image, keeps it running across reboots, and stores all data on a named volume so redeploys keep your configuration. Give the built image a tag if you deploy it elsewhere: `docker build -t pingu:0.1.0 .`.

## Use the browser setup wizard

The browser wizard is handy for Docker or another always-on host.

Set these environment values:

- `PHOTON_SETUP_TOKEN`: a random secret with at least 20 characters
- `PHOTON_CONFIG_KEY`: a different random secret with at least 24 characters
- `PHOTON_PUBLIC_URL`: the public HTTPS address for your host
- `PHOTON_DATA_DIR`: a persistent folder for settings, transcripts, and reminders

Start the app and open `/setup`. Enter the setup token and fill in the form. The page gives you the Google OAuth redirect address. Add that address to a Google Web OAuth client, then choose **Connect Google**. Use **Show a claim code** and text it from your phone to become the owner.

The wizard encrypts your saved keys and Google token with AES-256-GCM. Keep `PHOTON_CONFIG_KEY` safe. Keep the data folder backed up.

### HTTPS

Put the wizard behind HTTPS. The setup cookie is marked `Secure` only when `PHOTON_PUBLIC_URL` starts with `https://`; over plain HTTP the token travels in the clear. The simplest options are a reverse proxy such as Caddy, which obtains certificates automatically:

```
pingu.example.com {
  reverse_proxy localhost:3000
}
```

or a platform that terminates TLS for you (Fly.io, Railway, a home server behind Tailscale Funnel). Only the wizard needs the port; iMessage traffic goes through Photon, not through this port.

## Guest limits and cost

Anyone can text the number. The defaults in `.env.example` cap each unknown sender at 20 messages a day, all guests together at 300,000 model tokens a day, and each guest at 5 reminders and 1 pending meeting request. When a cap is hit, guests are told to try tomorrow; the owner is never limited. Set `PINGU_GUEST_DAILY_TOKEN_BUDGET` from your provider's per-token price to the daily spend you accept.

Bookable hours (`PINGU_BOOKABLE_HOURS`, `PINGU_BOOKABLE_DAYS`) decide what guests can see. A 24-hour window reveals when you sleep; keep it to the hours you would tell a stranger.

## Backup, update, rollback

**Backup.** Everything Pingu remembers is in `PHOTON_DATA_DIR` (default `data/`, or the `pingu-data` volume under Compose). Copy that folder. With the wizard, also keep `PHOTON_CONFIG_KEY`; the encrypted config is useless without it.

```bash
docker run --rm -v pingu-data:/from -v "$PWD":/to alpine tar czf /to/pingu-data-backup.tgz -C /from .
```

**Update.**

```bash
git fetch --tags
git checkout v0.1.1        # the release you want
npm ci && npm run check    # local
docker compose up -d --build   # Compose
```

Read the CHANGELOG entry first; a release notes any change to the data files. The first start after upgrading from a version with hosted conversations removes `conversations.json` and says so in the log.

**Rollback.** Check out the previous tag and start it again. Data files are read tolerantly, so an older version ignores fields it does not know. If a release changed a file's shape, restore the backup taken before the update.

## Delete data

- Ask Pingu to forget the current chat.
- `npm run reset-data -- --yes` or the **Delete all Pingu data** button on the setup page removes transcripts, reminders, alerts, drafts, guest records, verified owners, and booking requests. Credentials are kept.
- Remove `PHOTON_DATA_DIR` entirely to drop credentials too.

## Connect Granola

Add `GRANOLA_API_KEY` to `.env` or enter it in the browser setup form. Granola provides API keys for eligible Business and Enterprise workspaces.
