# Pingu - personal assistant on iMessage

[![CI](https://github.com/leendama/pingu/actions/workflows/ci.yml/badge.svg)](https://github.com/leendama/pingu/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![Self-hosted](https://img.shields.io/badge/hosting-self--hosted-6b4fbb.svg)](docs/SETUP.md)

<img width="150" height="300" alt="Pingu" src="https://github.com/user-attachments/assets/7c580305-9671-44cb-ad26-16c2f2d12cc9" />

Noot noot!

Pingu is a self-hosted assistant you text on iMessage. It reads and manages your Google Calendar, searches and drafts Gmail, reads Granola meeting notes, keeps reminders, and texts you when a chosen sender emails. Other people can text the same number to see when you are free and ask for a meeting, which you approve with one reply.

<img width="256" height="580" alt="Pingu on iMessage" src="https://github.com/user-attachments/assets/80ac66c3-6933-439a-b519-313124530d43" />

## What it does

**For you, the owner**

- Calendar: search, create, move, recolour, edit, and delete events. Moves are conflict-aware and verified.
- Gmail: search, read full messages, draft, and send after you confirm the exact draft.
- Email alerts: a text when a chosen sender emails you.
- Granola: list and read meeting notes.
- Reminders, tapbacks, read receipts, typing indicators, polls, rich links, contact cards, voice replies.
- Threaded group replies and group controls (Photon premium).

**For anyone else who texts the number**

- A one-line introduction on first contact.
- Your free windows for a day, inside the hours you allow, at most five, never with event details.
- A meeting request with a purpose and an email for the invite. Nothing is booked until you reply **yes** to the request text. Then Pingu creates the event, adds a Google Meet link, emails the invite, and tells both of you.
- Cancelling their own booking, which tells you.
- Reminders and ordinary chat, within daily limits.

## How Pingu compares

| | Pingu | OpenClaw | QwenPaw | OpenHuman | OpenYak | NativeMind |
|---|---|---|---|---|---|---|
| Where you talk to it | iMessage | iMessage, WhatsApp, Telegram, Signal, Discord, Slack | iMessage, Telegram, Discord, DingTalk, WeChat | Desktop app | Desktop app | Browser sidebar |
| Native message features | Tapbacks, polls, rich links, contact cards, voice | Text and attachments | Text and attachments | n/a | n/a | n/a |
| Others can use your assistant | Yes: free windows and meeting requests you approve | Team deployment | Not documented | No | No | No |
| Unknown senders | Anyone can chat; a claim code proves the owner | Pairing code | Access policy levels | n/a | n/a | n/a |
| Model | OpenAI, or tested Responses-compatible endpoints (Ollama, LM Studio) | Hosted and local | 14+ cloud, local | Routing, BYOK, Ollama | 20+ BYOK, local | Ollama, WebLLM |
| Zero-cloud mode | No, iMessage is relayed by Photon | Yes | Yes | Yes | Yes | Always |
| Memory | Local transcripts, retention setting, delete actions | Local | Local Markdown | SQLite and vault | Local | Page context |
| Install | Docker Compose plus a browser wizard | Installer plus gateway setup | pip, script, Docker | Installers | Installers | Chrome Web Store |
| License | Apache-2.0 | MIT | Apache-2.0 | GPL-3.0 | Apache-2.0 | AGPL-3.0 |

## Where your data goes

Pingu stores its state and conversation history on your machine. Messages are relayed through Photon, and prompts plus the connector results they need are sent to the model provider you configure. Point the model at Ollama or LM Studio and the model part stays on your hardware. Nothing about your calendar or email reaches a guest beyond the free windows you allow. [PRIVACY.md](PRIVACY.md) has the full picture, including what each party can see and how to delete everything.

## Set it up

You need Node.js 22 or newer, a [Photon](https://app.photon.codes) project with an iMessage line, a Google account, and either an OpenAI API key or a local model that supports function calling.

```sh
npm install
npm run start
```

With nothing configured, `npm run start` opens the setup wizard and prints a one-time link that signs you in. The wizard is one screen: your Photon project ID and secret, a model (a running Ollama or LM Studio is found and preselected, otherwise paste an OpenAI key), and **Connect Google**, which is only Google's consent screen when a release ships Pingu's own app registration. **Test connections** checks each one, including that Photon accepts the credentials.

The last screen shows a claim code. Text it to your Pingu number from your own phone within an hour. That number is recorded as the owner by the exact id the platform reports, private tools switch on in that chat, and the page flips to "Pingu is ready" when the first reply lands. Until someone claims, every sender is a guest. The same code is printed in the log at start whenever nobody owns Pingu yet, and `npm run claim` prints a fresh one.

Prefer a `.env` file? Copy `.env.example`, add `PROJECT_ID`, `PROJECT_SECRET`, and `OPENAI_API_KEY`, run `npm run connect:google`, then `npm run start`; the wizard is skipped.

For an always-on host, `docker compose up -d` and the browser wizard at `/setup` do the same job, including the claim code. Releases ship Pingu's own Google app, so there is no Google Cloud project to create; Google shows an "unverified app" notice once. Prefer your own project, or running the wizard on a remote host? [docs/SETUP.md](docs/SETUP.md) walks through it, with the one warning that catches most people: an OAuth app left in **Testing** issues sign-ins that expire after seven days.

Check any setup with:

```sh
npm run doctor
```

It probes the model endpoint (plain response, function calling, tool continuation, reasoning parameters), the Google sign-in and its permissions, and Granola, and says in plain language what is wrong.

## Models

By default Pingu uses `gpt-5.6-luna` at OpenAI. Set `OPENAI_BASE_URL` to use any OpenAI Responses-compatible endpoint that supports function calling. OpenAI, Ollama, and LM Studio are tested. The wizard and `npm run doctor` run the capability check before Pingu starts, and Pingu refuses to start against an endpoint that cannot call tools.

Inside Docker, `localhost` is the container. A model running on your Mac is `http://host.docker.internal:11434/v1`. A cloud-hosted Pingu cannot reach a model on a laptop that is switched off. Voice replies need OpenAI; the voice tool is simply absent otherwise.

## Guests and limits

Anyone can text the number, so the limits matter:

| Limit | Default | Setting |
|---|---|---|
| Messages per unknown sender per day, every message in a burst counted | 20 | `PINGU_GUEST_DAILY_MESSAGE_CAP` |
| Model tokens all guests may use per day, reserved before each turn and counted per response | 300,000 | `PINGU_GUEST_DAILY_TOKEN_BUDGET` |
| Hard ceiling per guest turn, longest guest text, tool rounds and reply length per guest turn | 20,000 tokens, 2,000 chars, 4 rounds, 1,500 tokens | `PINGU_GUEST_MAX_TURN_TOKENS`, `PINGU_GUEST_MAX_INBOUND_CHARS`, `PINGU_GUEST_MAX_TOOL_ROUNDS`, `PINGU_GUEST_MAX_OUTPUT_TOKENS` |
| Active reminders per guest, across all chats | 5 | `PINGU_GUEST_MAX_REMINDERS` |
| Pending meeting requests per guest | 1 | fixed |
| Bookable hours | 09:00 to 17:00 weekdays | `PINGU_BOOKABLE_HOURS`, `PINGU_BOOKABLE_DAYS` |
| Free windows shown per question | 5 | fixed |
| Buffer between meetings, minimum notice, lookahead | 15 min, 2 h, 14 days | fixed |
| Request expiry | 24 h | fixed |

The owner is never counted against guest limits. Guest-supplied email addresses are marked unverified in the request you approve.

## Run

```sh
npm run start
```

Everything Pingu remembers lives under `PHOTON_DATA_DIR` (default `data/`): chat transcripts, reminders, alerts, pending drafts, guest counters, verified owners, and booking requests. Reminders need the process running; an overdue one arrives when it starts again. Run one Pingu per data directory.

Forget one chat by asking Pingu to. Delete everything with `npm run reset-data -- --yes` or the button on the setup page; credentials are kept so you are not signed out.

## Email signature

Every email Pingu sends ends with "this email was composed by Pingu, noot noot" and a link to this repository. It is part of the product and cannot be switched off.

## Extensions and verification

Read [docs/PLUGINS.md](docs/PLUGINS.md) to add tools, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout, and [docs/SETUP.md](docs/SETUP.md) for the wizard, Docker, HTTPS, backups, updates, and rollback.

Before contributing, run:

```sh
npm run check
```

This runs the type checks, tests, and production build.

## Safety boundary

- Private Gmail, Calendar, and Granola tools exist only in the verified owner's direct messages. Groups and guests never see them.
- Email sending needs a delivered draft and your yes in the next message.
- Deleting a recurring event, an event with attendees, or several events at once needs your yes. A single personal event deletes in one step.
- Anything Pingu reads from email or meeting notes is treated as information, never as an instruction. Once a turn has read such content, every action tool is blocked for the rest of that turn except creating a review-only draft; Pingu asks you to repeat the request as a fresh message.
- Every calendar write is read back from Google and compared field by field with what was requested before Pingu says it is done. If Google rejected it, Pingu says nothing was changed. If the event came back different, Pingu says so.
- Guest bookings are created only after your reply, after rechecking the slot. A guest is told a request was sent only when at least one owner chat actually received it.
- Group renames and membership changes are owner-only, even in groups.
- Reminders belong to whoever created them; nobody else can list or cancel them.

See [SECURITY.md](SECURITY.md) for the security model and how to report a problem.
