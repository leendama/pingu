# Setup

## Run it on your Mac

You need Node.js 22 or newer.

1. Create a Photon Spectrum project at [app.photon.codes](https://app.photon.codes).
2. Connect an iMessage line to the project.
3. Create an OpenAI API key.
4. Copy `.env.example` to `.env`.
5. Add your Photon project ID, Photon secret, and OpenAI key to `.env`.
6. Install and start the assistant:

```bash
npm install
npm run start
```

## Connect Google Calendar and Gmail

1. Open Google Cloud.
2. Enable the Google Calendar API and Gmail API.
3. Create a desktop OAuth client.
4. Download the client file.
5. Save it as `credentials.json` in the project folder.
6. Run:

```bash
npm run connect:google
```

Your browser opens for approval. The token is saved in `data/google-token.json`.

## Check your setup

Before starting the assistant, or whenever something misbehaves:

```bash
npm run doctor
```

It tests every connection it can reach — the OpenAI key and model, the Google sign-in and its calendar and Gmail permissions, and the Granola key — and says in plain language what is wrong with any that fail. Photon credentials are verified when the assistant starts; the final proof is Pingu replying to a text.

In the browser wizard, the **Test connections** button runs the same checks. Once the assistant is running, the setup page also shows when Pingu last replied to a message.

To keep Pingu running on a Mac across logouts and reboots, create a LaunchAgent that runs `npm run start` in this folder, or use the Docker option below.

## Run with Docker Compose

```bash
docker compose up -d
```

This builds the image, keeps it running across reboots, and stores all data on a named volume so redeploys keep your configuration.

## Use the browser setup wizard

The browser wizard is handy for Docker or another always-on host.

Set these environment values:

- `PHOTON_SETUP_TOKEN`: a random secret with at least 20 characters
- `PHOTON_CONFIG_KEY`: a different random secret with at least 24 characters
- `PHOTON_PUBLIC_URL`: the public HTTPS address for your host
- `PHOTON_DATA_DIR`: a persistent folder for settings and reminders

Start the app and open `/setup`. Enter the setup token and fill in the form. The page gives you the Google OAuth redirect address. Add that address to a Google Web OAuth client, then choose **Connect Google**.

The wizard encrypts your saved keys and Google token with AES-256-GCM. Keep `PHOTON_CONFIG_KEY` safe. Keep the data folder backed up.

## Run with Docker

The simplest way is Compose (see "Run with Docker Compose" above) — it handles the build, restarts, and the persistent volume. To do it manually instead:

```bash
docker build -t pingu .
```

Run it with a persistent data folder and the four environment values above. Keep the container running for messages and reminders.

## Connect Granola

Add `GRANOLA_API_KEY` to `.env` or enter it in the browser setup form. Granola provides API keys for eligible Business and Enterprise workspaces.
