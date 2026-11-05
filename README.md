# Mandate

Part of AUGUR, which is proprietary; see `LICENSE`.

Intent, passed down floor by floor: the intent pillar app. It lives in its own repository and ships with AUGUR as a pillar app; AUGUR's guide to it is `docs/mandate.md` in the `augur` repository.

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists the app: its route, entry, the SDK range it works with |
| `frontend/` | The micro frontend the shell mounts at `/mandate` (`@apps/mandate-frontend`) |
| `service/` | The app's own API, reached through the gateway at `/api/mandate` (`@apps/mandate`) |

In `service/src`: `store.ts` keeps intents (memory, or Postgres in schema `mandate`), `rules.ts` says who sees and does what, `app.ts` is the API, and `inbox.ts` puts a part's back-brief in the shell's Inbox of whoever holds it (the person, or the team's leads) until it's said back, which needs the `inbox:write` scope an admin allows in Admin, Apps.

Set `NODE_AUTH_TOKEN` to a token that can read GitHub Packages, then `pnpm install`, `pnpm test` and `pnpm build`. Test the service on Postgres too with `DATABASE_URL=… pnpm --filter @apps/mandate test`. AUGUR's `docs/build-an-app.md` covers running it in a shell.

## Releases

| Workflow | When | What |
| --- | --- | --- |
| CI | Every pull request | Lint, typecheck, test and build |
| App previews | A pull request that changes the app | A signed preview its developers can run beside the app |
| App dev builds | Every merge into main | A signed dev build for preview servers |
| Release | Merging Version packages | The beta release `app/mandate@<version>`, then AUGUR's feed lists it |

Each needs two secrets: `PACKAGES_READ_TOKEN` (reads AUGUR's packages, unless each package grants this repository access) and `APP_RELEASES_TOKEN` (starts AUGUR's release feed workflow).
