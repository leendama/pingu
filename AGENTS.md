# Pingu agent instructions

Pingu is an iMessage assistant built with [Spectrum](https://photon.codes/docs/spectrum-ts) and pinned to `spectrum-ts@^12.8.0`. `src/index.ts` starts the app. `src/agent.ts` owns the runtime. Capability modules live in `src/capabilities/`.

## Working in this project

- Run the app with `npm run start`.
- Add providers in `src/agent.ts` and list them in the `Spectrum({ providers: [...] })` config.
- Add capabilities through `capabilityPlugin` and register them in `src/builtin-plugin.ts` or `src/community-plugins.ts`.
- Outgoing message content uses the builders documented in the skill (text, attachment, voice, contact, richlink, poll, group, custom).

## Environment

This project reads secrets from `.env`, which is ignored by Git. Never read, write, or print `.env`.

If startup fails with an authentication error, tell the user to verify their `PROJECT_ID` / `PROJECT_SECRET` at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

This project includes the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills). Your agent should auto-discover it. If it doesn't, or if you switch agents, install for your agent with:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

## Managing the Spectrum Cloud project (CLI)

The `PROJECT_ID` and `PROJECT_SECRET` belong to a Spectrum Cloud project. Use the `photon-cli` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills) to manage it:

```sh
npx skills add photon-hq/skills --skill photon-cli --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

Common tasks once it's installed:

- `photon whoami`: confirm authentication.
- `photon projects regenerate-secret`: rotate the Spectrum API secret.
- `photon spectrum lines list`: list messaging lines.
- `photon projects show`: inspect the active project.

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
