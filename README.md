# Mandate

Part of AUGUR, which is proprietary; see `LICENSE`.

Intent, passed down floor by floor: the intent pillar app. It lives in its own repository and ships with AUGUR as a pillar app; AUGUR's guide to it is `docs/mandate.md` in the `augur` repository.

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists the app: its route, entry, the SDK range it works with |
| `frontend/` | The micro frontend the shell mounts at `/mandate` (`@apps/mandate-frontend`) |
| `service/` | The app's own API, reached through the gateway at `/api/mandate` (`@apps/mandate`) |

In `service/src`: `index.ts` starts it with the service kit's app-service starter (`startAppService`: settings checked, jobs, frontend, registration, shutdown), `store.ts` keeps intents (memory, or Postgres in schema `mandate`), `rules.ts` says who sees and does what, `app.ts` is the API, and `inbox.ts` puts a part's back-brief in the shell's Inbox of whoever holds it (the person, or the team's leads) until it's said back, which needs the `inbox:write` scope an admin allows in Admin, Apps.

`reminders/` reminds people on time (AUGUR's ADR 0061). A sweep runs every 15 minutes as a scheduled job (once across every instance) and puts what has come due in the Inbox, once per due date:

- **The day before a part's back-brief-by date** (chosen when it's passed down): its holder's back-brief item says so.
- **Once the back-brief is late:** the holder's item says so, and whoever passed it down gets a "Waiting for a back-brief" item. That item closes once the back-brief comes in.
- **When an intent's rhythm comes round:** its holder gets "How it's going". It closes once they say.

A rhythm is an RFC 5545 rule without DTSTART, such as `FREQ=WEEKLY;BYDAY=MO`. It repeats at most daily and is read with `rrule`. An intent without one is asked every `rhythmDays` days (`FREQ=DAILY;INTERVAL=<days>`). Days and rules are worked out in the organisation's time zone, which comes from identity (UTC when it can't say). Each intent records what it was last reminded for (`reminded_brief_for`, `reminded_rating_for`), so nothing is sent twice. A reminder the Inbox didn't take is tried again on the next sweep.

In `frontend/src`, Mandate is built on SDK 2 with Quill's app starter: `entry.tsx` hands `defineReactApp` the app, its places, the intents that open it (`mandate.open`, `aim.open`), the `aim.pick` picker and the Home card. `app.tsx` holds its places on the address bar (`placeRoutes`: `/`, `/yours`, `/intents/:id`) and loads with `useData`, kept per floor; `api.ts` calls the service with `createAppClient`, checked against `MandatePaths` in `service/src/api-types.ts`, where the wire types are written once.

Set `NODE_AUTH_TOKEN` to a token that can read GitHub Packages, then `pnpm install`, `pnpm test` and `pnpm build`. Test the service on Postgres too with `DATABASE_URL=… pnpm --filter @apps/mandate test`. AUGUR's `docs/build-an-app.md` covers running it in a shell.

## Releases

| Workflow | When | What |
| --- | --- | --- |
| CI | Every pull request | Lint, typecheck, test and build |
| App previews | A pull request that changes the app | A signed preview its developers can run beside the app |
| App dev builds | Every merge into main | A signed dev build for preview servers |
| Release | Merging Version packages | The beta release `app/mandate@<version>`, then AUGUR's feed lists it |

Each needs two secrets: `PACKAGES_READ_TOKEN` (reads AUGUR's packages, unless each package grants this repository access) and `APP_RELEASES_TOKEN` (starts AUGUR's release feed workflow).
