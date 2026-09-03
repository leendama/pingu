# Pingu launch strategy

A study of ten consumer open-source launches, the distribution patterns they share, and a
dated plan that works backwards from those patterns to Pingu's own launch.

Researched 2026-09-03.

---

## 0. How to read the evidence

Research for this document ran from a sandboxed network. **producthunt.com, reddit.com,
news.ycombinator.com, hn.algolia.com, x.com and star-history.com were all unreachable**, and the
web-search budget was exhausted partway through. GitHub (repo pages, tagged READMEs, release
lists, discussions) and npm were reachable throughout.

So the evidence tiers are:

- **Verified (primary).** Repo creation dates, first-commit dates, release tags and their dates,
  README text at a given tag, star/fork counts, licence-change commits, GitHub Discussions.
  Everything about *cadence*, *sequencing* and *language* comes from this tier and is solid.
- **Verified (snippet).** Product Hunt upvote counts and Hacker News titles that appeared inside
  search-result summaries. Directionally reliable, not independently confirmed.
- **Not found.** Nearly all HN point counts, nearly all Reddit post titles and upvote counts, and
  several PH launch dates. These are marked `not found` and **not** estimated.

Where a number would have changed a recommendation and could not be verified, the recommendation
is built on the structural pattern instead of the number. Nothing below is invented.

---

## 1. The comparator set

Ten consumer-facing open-source projects, chosen because each is (a) self-hosted or local-first,
(b) aimed at an individual rather than a team, and (c) launched publicly in the last four years.
Star counts are as of 2026-09-03.

| # | Project | What it is | First commit | First public launch | Gap | Stars | Licence |
|---|---------|-----------|--------------|---------------------|-----|-------|---------|
| 1 | **OpenClaw** (`openclaw/openclaw`) | Personal assistant in your chat apps | 2025-11-24 | HN ~2026-01-24 | 2 months | 388,684 | MIT |
| 2 | **Khoj** (`khoj-ai/khoj`) | "AI second brain" over your docs | 2021-07-31 | HN Jul 2023 (by a stranger) | ~2 years | 37,026 | AGPL-3.0 |
| 3 | **Jan** (`janhq/jan`) | Offline ChatGPT replacement | 2023-08-17 | HN ~2023-12-31 | 4.5 months | 44,309 | Apache-2.0 |
| 4 | **Open WebUI** | Self-hosted AI chat front end | 2023-10-06 | HN ~2024-02-18 | 4.5 months | 150,775 | Custom (was MIT) |
| 5 | **Screenpipe** (`mediar-ai`) | 24/7 local screen + mic recall | 2024-06-19 | HN **and** PH 2024-09-30 | 3.5 months | 21,400 | Source-available (was MIT) |
| 6 | **Hyprnote** (`fastrepl`) | Local-first meeting notepad | ~2025-01-17 | PH 2025-04-18 | 3 months | 9,200 | MIT + commercial |
| 7 | **Immich** (`immich-app`) | Self-hosted photo library | 2022-02-03 | r/selfhosted, 2022 | weeks | 113,317 | AGPL-3.0 |
| 8 | **Karakeep** (was Hoarder) | Self-hosted bookmark-everything | 2024-02-06 | r/selfhosted 2024-03-26 | 7 weeks | 28,753 | AGPL-3.0 |
| 9 | **Omi** (`BasedHardware/omi`) | Open-source AI wearable + app | 2024-03-22 | X, **day 0** (hackathon) | 0 days | 13,378 | MIT |
| 10 | **Maybe Finance** | Self-hosted personal finance | 2024-01-10 | X + GitHub Trending, **days 0–5** | 0 days | 54,301 | AGPL-3.0 |

Rows 9 and 10 are the instructive exceptions, and Section 2 treats them as such: both launched on
day zero and both worked. Neither route is available to Pingu, for the reasons stated there.

### The iMessage-adjacent cohort

Not part of the ten, but the closest competitive reference points for Pingu specifically:

- **Poke** (Interaction Co) — closed-source iMessage assistant. $15M seed at $100M, 6,000 insiders
  before public launch, first AI agent approved for Apple Messages for Business (Jun 2026),
  acquired by Cognition. **Product Hunt: 223 upvotes, 20 comments.** A well-funded, well-connected
  team in exactly Pingu's category cleared only ~223 PH upvotes. That is the realistic PH ceiling
  for this category, and it reframes PH as a secondary channel.
- **Dot** (New Computer) — iOS companion app, claimed "hundreds of thousands" of users against
  ~24.5k actual downloads, shut down 2025-10-05. Companion framing without utility did not retain.
- **OpenInstinct** (Merit Systems) — "personal iMessage assistant that can use a browser like you,"
  self-hostable. Repo created 2026-08-25, **261 stars in 9 days**. The closest direct open-source
  competitor and it is nine days old. This window is open now.
- **`openclaw/imsg`** — Swift CLI for Messages.app, 1.3k stars. **BlueBubbles** — 1.4k stars.
- **Photon / `spectrum-ts`** — Pingu's own dependency; 1.6k stars, MIT, created 2025-12-20.
  Someone has already ported Hermes Agent to iMessage via Photon. The Photon ecosystem is a
  distribution surface Pingu is not yet using.

---

## 2. Pattern map — cadence

**For eight of the ten, the launch is not the beginning; it is the third or fourth event.** Those
eight shipped a runnable artefact, released repeatedly, and only then posted anywhere. The two
exceptions are treated below, and neither is reproducible here.

| Project | Runnable artefact | Releases before launch |
|---|---|---|
| Screenpipe | v0.1.2, **6 days** after first commit | ~10 releases in first 10 days |
| Immich | `first-android-release` tag, **3 days** after first commit | 6 dev tags before the Reddit post |
| Karakeep | v0.1.0, 14 days after repo creation | **8 versions** in the 5 weeks before launch |
| Open WebUI | demo.gif + `docker run`, **12 days** in | shipped for 4 months pre-launch |
| Hyprnote | first release 2025-03-11 | nightlies for 5 weeks before PH |
| OpenClaw | npm `warelay` 1.0.4 published **day 2** | 39 npm versions in 21 days |
| Jan | v0.2.0 at 2 months | ~10 releases before the HN post |

**Cadence after launch is the marketing calendar.** Immich: 271 releases in ~1,337 days, roughly
one every 4–5 days for years. Karakeep: 9 releases in the 4 weeks after launch, then weekly, then
monthly release-note posts. Screenpipe: 10 releases on a single day (2025-02-04). Jan: every 1–2
weeks for its first four months. Nobody in this set launched and then went quiet.

**The two exceptions launched on day zero — and both had bought the build-up another way.**

- **Maybe Finance** pushed its code public on 2024-01-10 with one tweet: *"Here's what $1,000,000
  worth of fintech software looks like…"*, framed as *"Maybe is dead, but here's the code if
  anyone wants it."* It was **#1 on GitHub Trending by 2024-01-15, adding over 15,000 stars that
  week**, raised ~$1.1–1.5M within about four weeks — and posted a Show HN only **sixteen months
  later** (2025-05-04). At 54,301 stars it is the second-highest in the set.
- **Omi** was built in 24 hours at a Mistral × Cerebral Valley hackathon and tweeted the same day
  (2024-03-22), with an anti-incumbent hook: *"another 'open-source' AI wearable that has not
  published anything just to charge you 5x the cost… we built FRIEND… Costs ~$20."*

Neither skipped the build-up so much as substitute for it: a founder with a large existing X
audience (Baremetrics) plus a "$1M of code, free" hook in one case; a live hackathon audience and
a published bill of materials undercutting a funded competitor in the other. **Pingu has neither**,
so the eight-project pattern is the one that applies. What these two do confirm is the value of a
single concrete, quotable hook — Section 4.

**Nobody launched everywhere at once, and nobody launched only once.**

- Screenpipe: HN + PH on the **same day** (2024-09-30), then PH again ~16 months later
  (2026-02-03, 23 upvotes), then again ~6 months after that (Aug 2026, 127 upvotes).
- Hyprnote: PH (Apr 18 2025) → Show HN (~1 week later) → Launch HN (Jul 29, ~3 months) → PH #2
  (Aug 11, **2 weeks after the HN post**, 365 upvotes, #2 Product of the Day).
- Jan: HN (Dec 31) → press (Jan 18) → PH tied to a "Jan is more stable" release (Feb 10, 338
  upvotes, #3) → HN again (Mar). Roughly **4–6 weeks between touches**, each pegged to a release.
- Karakeep: Reddit + HN in the same week (Mar 2024) → **HN again 9 months later** (Dec 2024) →
  10k-star release two weeks after that.
- Omi: hackathon tweet (day 0) → Kickstarter (+34d, **712 backers, $49,868 against a $5,000
  goal**) → PH 2024-07-26 (**723 upvotes, #1 Product of the Day**) → rebrand from Friend to Omi
  (+139d) → Show HN (+154d) → CES (+292d) → PH again (2025-06-13) → two further HN posts → **another
  PH launch going live today**, visible as a launch-day badge commit in the repo. One major beat
  every 3–5 months, each pegged to a new SKU.
- Khoj: a stranger's HN post in Jul 2023 went badly ("mere ChatGPT wrappers") → the makers' own
  **Show HN three weeks later** with a sharper angle ("chat offline… using Llama 2") went well.

The second wave is not a consolation prize. Hyprnote's *second* PH launch outperformed its first
by an order of magnitude, because by then it had a Launch HN, YC amplification and a real user base
behind it.

---

## 3. Pattern map — platform sequencing

Two distinct routes appear in the data, and they sort by audience, not by preference.

**Route A — the self-hosting route (Immich, Karakeep).** r/selfhosted first, then HN, then
newsletters (selfh.st picked up Karakeep within 10 days and covered four subsequent releases),
then homelab YouTube. **Neither used Product Hunt meaningfully** — Immich has a PH page it did not
drive, Karakeep has none at all. These are the two highest-star-count projects in the set outside
the AI-hype cohort. Product Hunt was not required for either.

**Route C — the audience drop (Maybe, Omi).** The founder's own X post first, GitHub Trending
doing the distribution, PH and HN arriving months later as secondary beats. This route spends an
audience you already have; it does not build one. Recorded for completeness and ruled out for Pingu.

**Route B — the AI-tool route (Jan, Screenpipe, Hyprnote, OpenClaw).** HN first (or HN and PH the
same day), then PH within 2–6 weeks pegged to a stable release, then press and YouTube pull.

Across 138 HN-exposed repos studied in 2024–25, the average gain was **121 stars in 24h, 189 in
48h, 289 over 7 days**, with posting between 12:00–17:00 UTC worth roughly 200 extra stars; the
"Show HN" tag itself conferred no measurable advantage once other factors were controlled
(arXiv 2511.04453). A separate analysis of 50 repos that reached 10k stars found **87% launched
on HN first**, then Reddit and X.

**The single most under-priced channel in this data is other people posting for you.**
Screenpipe's front-page HN thread was submitted by a user, not the founder — Louis replied
"Thanks for sharing screenpipe :) (author here)". Khoj's first HN appearance was also a stranger's.
Open WebUI was being recommended *unprompted* in HN comment threads about Ollama before it ever
had its own front-page post. OpenClaw's defining moment was **a user's tweet** about running it on
a Mac mini in his garage, which doubled the star count overnight — not anything the maker posted.

The corollary, from Khoj: if you have not framed the project yourself, someone else will frame it
for you, and they may frame it as a wrapper.

**Reddit rules are hard constraints, not etiquette.** Verified this session:
- **r/macapps** — developer promos only via the "PCP" template, **max once per developer per 30
  days**; you cannot promote in comments until you hold 10 subreddit karma.
- **r/apple** — developer self-promotion **on Sundays only**.
- **r/ClaudeAI** — 1.1M members; the "Built with Claude" flair requires what you built, how,
  screenshots or a demo, and at least one prompt used.
- **r/LocalLLaMA** — keep promo under ~10% of activity, disclose affiliation, no link in the title,
  lead with technical detail.
- **r/SideProject** — self-promo allowed but the real product must be reachable; waitlist or
  email-gated posts are removed.

---

## 4. Pattern map — language

Every README opening in the set, verbatim, arranged by what it leads with:

**"Open-source alternative to [known product]"** — the highest-performing frame, and the one
aggregators copy.
- Jan: *"an open-source ChatGPT alternative that runs 100% offline on your computer"* — this exact
  phrasing was locked into the README on 2023-12-21 and appeared **ten days later** in the HN
  title, then verbatim in MarkTechPost, Linux Today and the PH tagline.
- Screenpipe: *"Alternative to Rewind.ai. Open. Secure. You own your data. Rust."*
- Hyprnote: *"The privacy-first AI meeting notepad. Open source, local-first, and yours to fork.
  Granola, rearranged."*
- Karakeep launched as *"mymind open source alternative"* in the Reddit title itself.
- Immich never says "Google Photos" in its README — but carries the repo topic
  `google-photos-alternative`, and every piece of press calls it exactly that.

**Ownership and location of data** — the second universal element.
- OpenClaw: *"Your assistant, on your devices, in your chats"* / *"channels you already use"*
- Screenpipe: *"Free. You own your data."*
- Hyprnote: *"Not a single byte of data leaves your device."*
- Khoj: *"Khoj is open-source, self-hostable. Always."*
- Jan: *"You own your own AI"*

**Honest instability, stated up front** — counter-intuitively a growth asset.
- Immich: *"⚠️ NOT READY FOR PRODUCTION! DO NOT USE TO STORE YOUR ASSETS !!"* and later
  *"under **very active** development"* — while going from 0 to 113k stars.
- Karakeep: *"This app is under heavy development and it's far from stable."*
- Jan: *"Jan is currently in Development: Expect breaking changes and bugs!"*

To r/selfhosted, a stability warning reads as momentum, not as a defect.

**Positioning drift is the failure mode.** Hyprnote's own retrospective, *"Why We Burned It
Down"*, blames an over-engineered pile of "local-first everything… BYOK, lifetime license" for a
confused product; the team rewrote from scratch and rebranded to Char. Screenpipe drew an
*"Ask HN: Is anyone else confused about the business model of Screenpipe?"* thread **two days
after launch**. Jan won by *narrowing* — from "Run your own AI" (Oct 2023) to "Own Your AI"
(Dec 6) to "an open-source ChatGPT alternative that runs 100% offline" (Dec 21).

**A hook is not the same as a description, and the day-zero launches won on hooks.** Maybe led
with a number — *"what $1,000,000 worth of fintech software looks like"*; Omi led with a price
comparison — *"$20, 24h battery, while others charge 5x and have published nothing."* Both are
concrete, checkable and quotable in someone else's words, which is what makes them travel. Neither
is a product description. Pingu's candidate hook is the setup cost against what it replaces: an
assistant that answers in the app already on your phone, running on your own box, for the price of
your own API key.

Structurally, the winning line is: **[open-source / self-hosted] + [known product it replaces] +
[where your data stays]**, in one sentence, identical across the GitHub description, README H1,
HN title and PH tagline — with the hook carried alongside it, not folded into it.

---

## 5. Pattern map — content assets

What existed *before* the first launch post, in every case:

1. **A demo you can watch without installing.** Open WebUI had `demo.gif` on day 10. Jan had a
   video ("Jan v0.3.0 on Mac Air M2, 16GB Ventura"). Khoj had a GIF of a chat solving a quadratic.
   Immich had mobile + web screenshots and a **public demo instance** (`demo@immich.app`).
   Karakeep opens its README with a screenshot and offers `try.karakeep.app` read-only.
2. **A one-command install.** `docker run -d -p 3000:8080 …` (Open WebUI), `docker compose up`
   (Karakeep, Immich), `npm install -g clawdbot@latest && clawdbot onboard --install-daemon` then
   `curl -fsSL https://openclaw.ai/install.sh | bash` (OpenClaw), `brew install screenpipe`,
   `brew tap fastrepl/hyprnote && brew install hyprnote --cask`. Omi states the standard most
   explicitly — `git clone … && ./run.sh --yolo`, advertised as *"No env files, no credentials, no
   local backend."* That is the exact inverse of Pingu's current onboarding.
3. **A Discord, linked from the README badge.** Universal. Khoj's makers: *"The Discord community
   has been OP… ample, active feedback."* OpenClaw's hit 8,900+ members within weeks.
4. **A docs site separate from the README.** docs.khoj.dev, docs.screenpi.pe, docs.karakeep.app,
   Immich's docs + a **dated public roadmap page**.
5. **A dated changelog.** Jan published one from v0.4.3. Karakeep posts a GitHub Discussion per
   release. Immich titles releases as events: *"v1.120.0 - 50.000 Stars Release"*.

**Growth mechanics worth stealing:**

- **Screenpipe gave away a free desktop-app licence for a PR *or* for "sharing about screenpipe
  online"** — a referral loop wired into the product from launch day — plus paid bounties
  (*"[bounty] $100 convert the reddit pipe to nextjs app"*) and a plugin marketplace with Stripe
  payouts to plugin authors.
- **The repo as the community stage.** Open WebUI turned a trademark-forced rename into a public
  poll (86 votes, 51 comments across two discussions). Immich published a dated milestone roadmap.
  Karakeep's *"10k ⭐ release"* and Immich's *"50.000 Stars Release"* turn metrics into content.
- **Clone-wave naming.** After OpenClaw, `*claw` projects positioned as "lighter/safer/faster than
  OpenClaw" captured enormous attention in weeks: NanoClaw 30.7k★, Nanobot 47.7k★, PicoClaw 29.9k★
  (12k in week one), ZeroClaw 32.7k★, QwenPaw 34.8k★, Hermes Agent 240k★. Naming into an existing
  wave with a clear differentiator is currently the highest-leverage move in this category.
- **Pre-empt the security thread.** OpenClaw's largest press cycle was negative: ~900 exposed
  gateways on port 18789, CVE-2026-25253, and a Moltbook Supabase leak of 1.5M tokens and 35k
  emails. Screenpipe got its business-model interrogation within 48 hours. **The critical thread
  arrives on day one or two, every time.** The only variable is whether you have already answered
  it in writing.

---

## 6. Pingu today — the honest gap audit

Verified against the repo on 2026-09-03.

**What Pingu has:**
- Working product: iMessage assistant on Photon/Spectrum with Google Calendar, Gmail, Granola,
  reminders, voice replies, polls, tapbacks, rich links, contact cards.
- **Apache-2.0** — the most permissive licence in the comparator set, and stable. (Jan spent two
  licence changes getting here; Open WebUI's move to a custom licence cost it a HN and Lobsters
  backlash.)
- A real, specific security model, already written down in `SECURITY.md`: one owner per install,
  AES-256-GCM config encryption at rest, private tools blocked in group chats, email sending
  requiring a stored draft plus separate confirmation.
- A browser setup wizard at `/setup`, `npm run doctor` diagnostics, `/healthz`, a Dockerfile and
  a `docker-compose.yml`.
- A capability-plugin architecture (`capabilityPlugin`, `PINGU_PLUGIN_DIR`) — i.e. the substrate
  for a Screenpipe-style contributor loop already exists.
- 24 test files and a green CI workflow.

**What Pingu is missing, ranked by how much it costs at launch:**

1. **No one-command install.** This is the biggest gap by a wide margin. Every comparator had one
   before launching. Pingu currently requires Node 22, a `.env`, **a Photon project, a Google
   OAuth app and an OpenAI API key** — four accounts before the first message. Karakeep's r/selfhosted
   launch worked because the answer to "how do I try it" was `docker compose up`.
2. **No demo GIF or video.** The README has two static screenshots. An assistant answering in a
   real iMessage thread is inherently the most watchable thing about this project, and it is
   currently invisible.
3. **No releases, no tags, no changelog.** `git tag` is empty. `package.json` says `0.1.0`. There
   is nothing to link to, nothing to announce, and no evidence of momentum.
4. **No Discord, no docs site, no landing page.**
5. **No `CONTRIBUTING.md`, no issue templates**, and no published list of wanted capability plugins
   — so a visitor who likes it has nowhere to put that energy.
6. **2 stars.** There is no warm audience. Nothing about the plan below can assume one.

**And one strategic constraint that must not be fudged:** Pingu is **self-hosted, not local-first.**
Messages route through Photon/Spectrum Cloud and inference runs against the OpenAI Responses API.
Section 4 shows that this category's most effective language is precisely the language Pingu cannot
honestly use — "not a single byte leaves your device" is Hyprnote's line and it is not available
here. Claiming it would produce exactly the Screenpipe/OpenClaw day-two thread, and would deserve
to. The workable claim is narrower and still strong: **your assistant runs on your machine, under
your keys, with your data in your own store — no third-party assistant product in the middle.**
Say what Photon does, in the README, above the fold, before anyone finds it themselves.

---

## 7. Solving backwards — the plan

Working backwards from the patterns: the launch post is event four, the install must be one
command, the frame must be fixed before anyone else fixes it, and the security answer must be
written before the question arrives.

Dates assume a start of **Thursday 2026-09-03**. All timing is anchored to weekdays because the
data is: HN Tue–Thu 12:00–17:00 UTC; PH launches at 12:01am PT; r/apple accepts developer posts
on Sundays only.

### Phase 0 — Build the launch surface (Sep 3 – Sep 13, no posting)

Nothing gets posted anywhere in this window. Deliverables:

- [ ] **One-command install.** Target: `docker compose up` or `npx pingu onboard` gets a working
      assistant. The Photon + Google + OpenAI key collection should happen inside the existing
      `/setup` wizard, not in a `.env` the user hand-edits. This is the highest-value work item in
      the entire plan.
- [ ] **A 20–30 second screen recording** of a real iMessage thread: ask about today's calendar →
      "what did I agree to in the Granola notes from Tuesday?" → a voice reply. Phone-screen
      recording, no narration, loops cleanly. Becomes the README hero, the PH gallery's first
      image, and the native video on X.
- [ ] **Rewrite the README's first three lines** to the fixed frame (Section 8), with the Photon
      data-path disclosure immediately under it.
- [ ] **Tag `v0.2.0` and write a changelog.** Then keep tagging.
- [ ] **A "What Pingu can and cannot see" section** in the README, linking `SECURITY.md`. Pingu's
      security model is genuinely better than OpenClaw's was at launch; that is a differentiator
      only if it is legible before the question is asked.
- [ ] **Discord + `CONTRIBUTING.md` + 5–10 `good first issue` capability-plugin ideas.**
- [ ] **A redaction-safe diagnostic bundle**, extending `npm run doctor`, plus a documented failure
      mode per integration (Google, Granola, Photon). This is the Maybe Finance lesson in Section 9:
      an assistant holding someone's calendar and inbox cannot be debugged from a stranger's report
      unless you have built the way to ask.

### Phase 1 — Visible cadence, still no launch (Sep 14 – Sep 21)

- [ ] **Three tagged releases in eight days** (v0.2.1 → v0.3.0). Matches Karakeep's pre-launch
      shape exactly; means the repo shows a heartbeat when strangers arrive.
- [ ] Answer questions in the Photon/`spectrum-ts` Discord and issues as a participant, not a
      promoter. Pingu is a flagship example of what Spectrum is for; that ecosystem is warm and
      currently unused.
- [ ] Post the demo video on X as **native video, GitHub link in the first reply** — X's
      open-sourced recommender buries external links and weights replies above reposts.

### Phase 2 — D-Day: Tuesday 2026-09-22

The Khoj lesson decides the order: **frame it yourself, first.**

- **08:00–10:00 ET — Show HN.** Title: `Show HN: Pingu – open-source personal assistant that lives
  in your iMessage`. Maker's first comment goes up immediately (draft in Section 8). Then clear the
  day: 12+ hours of replies. Expect and welcome the security question — the answer is already written.
- **Same day — r/selfhosted.** Required flair, affiliation disclosed, `docker compose up` visible in
  the post body, honest alpha warning. This is Immich's and Karakeep's channel and it is Pingu's
  best-fit audience.
- **Not Product Hunt.** PH on day one would burn the one launch slot (a relaunch needs 6 months plus
  a significant update) on a repo with no stars, no reviews and no demo traffic.

### Phase 3 — Stagger the rest (Sep 23 – Oct 4)

One channel at a time, each with a different angle, each respecting its rules:

- **Sep 24 (Thu) — r/LocalLLaMA.** Angle: the capability-plugin architecture and the model
  configuration surface. Lead with technical detail, no link in the title, disclose affiliation.
  Be straight that inference is the OpenAI Responses API — this subreddit will find out otherwise.
- **Sep 27 (Sun) — r/apple.** Developer self-promotion is Sunday-only. Angle: iMessage-native,
  tapbacks/read receipts/voice replies.
- **Sep 29 (Tue) — r/macapps**, via the PCP template. **One shot per 30 days** — do not spend it early.
- **Sep 30 (Wed) — r/ClaudeAI**, "Built with Claude" flair, which requires build details, a demo and
  at least one prompt shown. 1.1M members.
- **Throughout — selfh.st.** It picked up Karakeep within 10 days of launch and covered four
  subsequent releases. Submit the release, then every meaningful release after.

### Phase 4 — Product Hunt: Wednesday 2026-10-21

Roughly four weeks after HN, matching Jan (6 weeks) and Hyprnote (2 weeks post-HN), and pegged to a
**v1.0 stable release shipping the same morning** — Jan's PH launch coincided with its "Jan is more
stable" changelog entry, and that pairing is the pattern.

- Go live **12:01am PT**; the first ~4 hours are hidden-vote and decide whether you lock into the
  top 4.
- **Self-hunt.** 79% of featured posts and 60% of #1 finishers are self-hunted; PH itself says
  big-name hunters have mattered less since 2025.
- Tagline ≤60 chars, description ≤500 (first 250 visible), thumbnail 240×240, **4–6 gallery images
  at 1200×630 with the phone screen recording first** (image one is the social preview), maker's
  first comment ≤800 chars. Topics: Open Source, Developer Tools, Artificial Intelligence.
- Ask for feedback and reposts. Never ask for upvotes — votes are trust-weighted by voter graph,
  account age and geography, and suspicious ones are stripped roughly every two hours.

### Phase 5 — The second wave (Nov 2026 – Feb 2027)

This is where the comparator data says the real growth is, and it is the half most projects skip.

- **Monthly release-note posts** as GitHub Discussions, mirrored to r/selfhosted (Karakeep's exact
  loop). Weekly releases through October, then monthly.
- **A second HN post at a milestone**, 3–9 months out — Karakeep's second HN hit came 9 months
  after the first; Screenpipe's PH relaunches were 16 and then 6 months apart; Hyprnote's second PH
  outperformed its first by 20×. Peg it to a real event: a v1.0, a 1,000-star release, or a new
  capability that stands alone.
- **A contributor loop.** Ship a plugin registry page and label capability-plugin issues as bounties
  or featured contributions. Screenpipe's free-licence-for-a-PR-or-a-post mechanic is the single
  most directly copyable growth device in this set, and Pingu's plugin architecture already supports it.
- **Milestones as content.** "500 stars" and "v1.0" releases titled as events, Immich-style.

---

## 8. Copy, pre-drafted

**The fixed frame** — identical in the GitHub description, README H1, HN title and PH tagline:

> **Pingu — an open-source personal assistant that lives in your iMessage.**
> Self-hosted, Apache-2.0, your calendar, inbox and meeting notes, under your own keys.

**GitHub repo description** (currently: "Self-hosted AI mate on iMessage with Calendar, Gmail,
Granola, reminders, voice, and plugins.") — tighten to lead with the category:

> Open-source personal assistant that lives in your iMessage. Self-hosted, plugin-extensible,
> connects your calendar, Gmail and Granola notes.

Add repo topics: `imessage`, `self-hosted`, `personal-assistant`, `openai`, `typescript`,
`ai-agent`, `spectrum`, `photon`.

**Show HN title** (`Show HN: Pingu – open-source personal assistant that lives in your iMessage`)

**Show HN first comment** (post immediately after submitting):

> I wanted an assistant I could just text, in the app I already have open, without installing
> anything on my phone or handing my calendar and inbox to a third-party assistant product. So
> Pingu runs on my own machine (or a small box / Docker), holds my own OpenAI key, and answers in
> iMessage.
>
> It does calendar, Gmail, Granola meeting notes, reminders and email alerts, with tapbacks, read
> receipts, typing indicators, polls and voice replies. About 3,600 lines of TypeScript, Apache-2.0,
> and capabilities are plugins — there's a `PINGU_PLUGIN_DIR` for private ones you don't want in
> the repo.
>
> On the honest limits: iMessage delivery goes through Photon/Spectrum Cloud (there is no supported
> way to send iMessage from a Linux box otherwise), and inference is the OpenAI Responses API. So
> this is self-hosted, not local-only, and I'd rather say that here than have you find it. What
> *does* stay yours: the config and message store on your disk (AES-256-GCM at rest), one owner per
> install, private tools blocked in group chats, and email sending that requires a stored draft plus
> a separate confirmation. `SECURITY.md` has the full model.
>
> `docker compose up` and a browser setup wizard. It's alpha — expect breaking changes. Happy to
> answer anything, especially about the security model.

**Product Hunt tagline** (52 chars): `Open-source personal assistant that lives in iMessage`

**PH description** (~240 chars, so it survives the 250-char fold):

> Pingu is a self-hosted personal assistant you text in iMessage. It answers from your Google
> Calendar, Gmail and Granola meeting notes, sets reminders, and replies with voice. Apache-2.0,
> runs on your own machine with your own API keys.

**r/selfhosted title:**

> Pingu — a self-hosted personal assistant that answers in iMessage (calendar, Gmail, Granola
> notes). Docker Compose, Apache-2.0, alpha

The "alpha" is deliberate: Immich and Karakeep both grew past 28k stars while leading with a
stability warning, and to this audience it reads as momentum.

---

## 9. Targets and how to read them

Grounded in the measured data, not in ambition:

| Metric | Realistic | Good | Outlier |
|---|---|---|---|
| HN points | 60–120 | 150–300 | 500+ |
| Stars, 24h after HN | ~120 (measured average) | 300–500 | 1,000+ |
| Stars, week 1 | 250–400 | 800–1,500 | 3,000+ |
| PH upvotes (Oct 21) | 150–250 | 300–500 | 700+ |
| PH rank | top 10 | top 5 | #1 (needs 500–1,200 weighted) |

**Calibration:** the average HN-exposed repo gains 121 stars in 24 hours and 289 over a week.
Poke — VC-backed, in this exact category, with a distribution advantage Pingu does not have —
took **223 PH upvotes**. Usertour reached ~1,200 stars three months after a PH launch. Treating
"top of HN" as the base case is how launches get called failures.

The two big PH numbers in the set do not move these targets, because both were bought elsewhere.
Omi's **723 upvotes and #1 Product of the Day** came 126 days after its repo opened, on the back of
a completed Kickstarter (712 backers, $49,868), a same-day press release, and a giveaway of five
physical devices. Maybe's 15,000 stars in a week came from a founder's audience and a $1M hook, not
from a launch post. Neither is a target Pingu can plan toward on day one; both are what the second
and third waves in Phase 5 are for.

**What actually predicts the outcome**, in order: (1) whether `docker compose up` genuinely works
for a stranger on the first try; (2) whether the demo video is watchable in 20 seconds; (3) whether
the maker is in the comments for 12 hours; (4) whether the security answer is already written down.
Channel choice matters less than any of these.

**Kill criteria and pivots.** If the Show HN gets under 30 points, do not relaunch it — that is
Khoj's Jul 2023 outcome, and their recovery was a *different, sharper* Show HN three weeks later
("chat offline… using Llama 2"), not a repost. Pingu's equivalent sharper angle is the Granola
one: *"Show HN: Text your meeting notes — Granola recall over iMessage."* Hold it in reserve.

**The failure mode to design against is Maybe's, not Poke's.** Maybe reached 54,301 stars and
still archived the repo on 2025-07-27. Its v0.6.0 post-mortem names the cause: *"the single biggest
challenge… is bank providers"* — a product whose core value sat behind third-party integrations it
did not control — compounded by a privacy paradox, in that users of a personal-finance tool would
not share data to reproduce bugs. **Pingu's dependency profile is the same shape**: Google, Granola
and Photon for capability, and an assistant holding a user's calendar and inbox is exactly as hard
to debug from a stranger's report. Two things follow, and both belong in the pre-launch window
rather than after it: document each integration's failure mode so a broken provider degrades
visibly instead of silently, and ship a redaction-safe diagnostic bundle (`npm run doctor` is the
natural home) so a user can file a useful report without pasting their life into an issue.

**The window is real and it is narrow.** OpenInstinct — self-hostable iMessage assistant — went
from zero to 261 stars in nine days, having been created on 2026-08-25. Poke has left the
open-source lane entirely via acquisition. The `*claw` clone wave has established that "the
[adjective] one" positioning works in this category right now. Pingu's differentiated claim —
iMessage-native, Apache-2.0, plugin-extensible, with a real per-owner security model — is
available today and will not be in six months.

---

## Appendix — source coverage

| Claim type | Source | Confidence |
|---|---|---|
| Repo creation, first commit, release tags and dates | GitHub API / release pages | Verified |
| README text at specific tags | `raw.githubusercontent.com` at pinned commits | Verified |
| Star and fork counts (2026-09-03) | GitHub API | Verified |
| Immich star milestones by date | The repo's own `roadmap.tsx` at v1.141.0 | Verified |
| PH upvotes: Omi 723 (#1 POTD), Hyprnote 365, Jan 338, OpenClaw 758, Poke 223, Screenpipe 23/127 | Search snippets of blocked PH pages | Snippet only |
| Omi and Maybe git history, tags, README evolution | Full local clones of both repos | Verified |
| Omi Kickstarter (712 backers, $49,868); Maybe funding ~$1.1–1.5M | Search snippets; funding figure conflicts between sources | Snippet only |
| HN post titles and IDs | Search snippets | Snippet only |
| **All HN point counts** | — | **Not found** (HN blocked) |
| **Nearly all Reddit titles and upvotes** | — | **Not found** (Reddit blocked) |
| Reddit subreddit rules | Third-party rule aggregators | Snippet only — re-check each sidebar before posting |
| PH mechanics (12:01 PT, vote weighting, 6-month relaunch, self-hunt rates) | `fmerian/awesome-product-hunt` launch guide/kit on GitHub | Verified |
| HN star-gain averages | arXiv 2511.04453 + its companion repo | Verified |

All ten comparators are now profiled. Omi and Maybe Finance were verified from full local clones
of both repos (git log, tags, README history) plus the GitHub API; their Kickstarter totals, PH
figures and funding amounts come from search snippets and are flagged as such above. Reported
funding for Maybe conflicts between sources (~$1.1M vs ~$1.5M) and is given as a range.

Every conclusion in Sections 2–5 rests on at least four independently verified projects.
