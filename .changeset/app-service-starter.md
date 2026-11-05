---
'@apps/mandate': minor
---

Mandate starts with the service kit's app-service starter: its settings are checked before it starts (in production a missing one stops it, saying which), it runs jobs on the service kit's jobs engine, and it registers, gives its frontend and shuts down the one way every app does. Its schema is brought up to date by the service kit's `runMigrations`, which keeps the same `mandate.migrations` record. Every refusal is now an RFC 9457 problem details body, which still carries `error` and `message` for the frontend.
