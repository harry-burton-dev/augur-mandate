---
'@apps/mandate': patch
---

Mandate keeps its intents only in Postgres: its in-memory stores are gone, and its tests run on real Postgres in CI. Under `pnpm dev:app` it needs `DATABASE_URL` (the dev stack's Postgres).
