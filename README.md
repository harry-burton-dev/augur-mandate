# Mandate

Intent, passed down floor by floor: the intent pillar app. Working name; see [docs/mandate.md](../../docs/mandate.md).

| Path | What it is |
| --- | --- |
| `manifest.json` | How the registry lists the app: its route, entry, the SDK range it works with |
| `frontend/` | The micro frontend the shell mounts at `/mandate` (`@apps/mandate-frontend`) |
| `service/` | The app's own API, reached through the gateway at `/api/mandate` (`@apps/mandate`) |

In `service/src`: `store.ts` keeps intents (memory, or Postgres in schema `mandate`), `rules.ts` says who sees and does what, `app.ts` is the API.

Run it in a stand-in shell with `pnpm dev:app mandate`. Test the service on Postgres too with `DATABASE_URL=… pnpm --filter @apps/mandate test`. See [Build an app](../../docs/build-an-app.md).
