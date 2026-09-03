# Pingu - personal assistant on iMessage

<img width="150" height="300" alt="image" src="https://github.com/user-attachments/assets/7c580305-9671-44cb-ad26-16c2f2d12cc9" />

Noot noot!

This is a free personal iMessage assistant built with Photon and the OpenAI Responses API. It remembers conversations and connects to Google Calendar, Gmail, and Granola. It can also text you when a new email arrives from a chosen sender.

<img width="256" height="580" alt="image" src="https://github.com/user-attachments/assets/80ac66c3-6933-439a-b519-313124530d43" />



Pingu can handle:
- Reminders
- Tapbacks
- Read receipts
- Typing indicators
- Polls
- Rich links
- Contact cards
- Voice replies
- Threaded group replies (Photon premium needed)
- Group controls (Photon premium needed)

## Waitlist page

`site/` is a static landing page styled as an iMessage thread. Emails go to a Google Sheet through Apps Script; see `site/apps-script/README.md` for the one-time setup. Pushes to `main` that touch `site/` deploy it to GitHub Pages.

## Set it up

You need Node.js 22 or newer.

You also need a (1) Photon project (2) Google account and (3) an OpenAI API key. Granola connection is optional.

1. Install the dependencies:

```sh
npm install
```

2. Copy `.env.example` to `.env`. You can keep it elsewhere and set `PINGU_ENV_FILE` to its full path.

3. Add these values from the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`
- `OPENAI_API_KEY`

By default, the assistant uses `gpt-5.6-luna`. Voice notes use `gpt-4o-mini-tts`.

## Connect Google

1. In Google Cloud, enable the Google Calendar API and Gmail API.
2. Create an OAuth desktop client. Save it as `credentials.json`, or set `GOOGLE_CREDENTIALS_PATH` to its full path.
3. Connect your account:

```sh
npm run connect:google
```

Your Google token is saved under `PHOTON_DATA_DIR`, or in `data/google-token.json` when no external data directory is set. The assistant can read Calendar, create events, move one event or a whole sequence without calendar clashes, clean up duplicate events, change event colours, edit events, search Gmail, read complete email bodies, and create drafts. It sends email after showing the full draft and receiving confirmation in your next message.

## Connect Granola

Add a Granola Personal or Enterprise API key to `.env`:

```dotenv
GRANOLA_API_KEY=your_granola_api_key
```

The assistant can now list and read your meeting notes.

## Run

```sh
npm install
npm run start
```

Conversation IDs live in `data/conversations.json`. This keeps context across restarts. Remove a conversation entry when you want a fresh chat.

Reminders live in `data/reminders.json`. Keep the process running to receive them on time. An overdue reminder arrives when the process starts again.

For a clean public checkout, keep `.env`, Google credentials, runtime data, and personal plugins in a separate private directory. Set `PINGU_ENV_FILE`, `GOOGLE_CREDENTIALS_PATH`, `PHOTON_DATA_DIR`, and `PINGU_PLUGIN_DIR` to their full paths.

## Extensions and verification

Read [docs/PLUGINS.md](docs/PLUGINS.md) to add tools. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout. Read [docs/SETUP.md](docs/SETUP.md) for browser and Docker setup.

Before contributing, run:

```sh
npm run check
```

This runs the type checks, tests, and production build.

## Current safety boundary

Calendar creation, moves, edits, deletions, and Gmail drafting happen straight away when the request is clear. Pingu asks one short question when a request is ambiguous and sends a visible notice when an action or reply fails. Email sending requires a delivered draft and confirmation in the next message. Gmail, Calendar, and Granola stay private in group chats. Granola editing is currently unavailable.
