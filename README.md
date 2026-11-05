# Mandate

Part of AUGUR, which is proprietary; see `LICENSE`.

Intent, passed down floor by floor: the intent pillar app. It lives in its own repository and ships with AUGUR as a pillar app; AUGUR's guide to it is `docs/mandate.md` in the `augur` repository.

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists the app: its route, entry, the SDK range it works with |
| `frontend/` | The micro frontend the shell mounts at `/mandate` (`@apps/mandate-frontend`) |
| `service/` | The app's own API, reached through the gateway at `/api/mandate` (`@apps/mandate`) |

In `service/src`: `index.ts` starts it with the service kit's app-service starter (`startAppService`: settings checked, jobs, frontend, registration, shutdown), `store.ts` keeps intents (memory, or Postgres in schema `mandate`), `rules.ts` says who sees and does what, `app.ts` is the API, and `inbox.ts` puts a part's back-brief in the shell's Inbox of whoever holds it (the person, or the team's leads) until it's said back, which needs the `inbox:write` scope an admin allows in Admin, Apps. `follow.ts` follows the platform and Data Atlas (the `events:subscribe` scope): a part whose holder is signed out for good, leaves, or leaves the team whose floor it's on is marked as needing a holder, and whoever passed it down is asked in their Inbox to pass it again (`POST /intents/:id/pass-again`); a renamed team's floor shows its new name; an entity Data Atlas retires is shown as retired, and one it merges moves to the survivor, and back if the merge is split. Bindings are told in ADR 0066's shape (`mandate.intent.entity-bound`). Each intent has a discussion (`GET /threads`, `POST /threads/messages`, keyed by the intent's ref as ADR 0028 asks): whoever holds a part raises concerns and leaves notes, and whoever passed it down answers. A concern raised in a back-brief starts it. While a part waits for its back-brief, whoever passed it down can change it (`PATCH /intents/:id/passed`), which issues the next version and answers the waiting concern.

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
