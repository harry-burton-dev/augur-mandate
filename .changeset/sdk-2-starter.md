---
'@apps/mandate-frontend': minor
---

Mandate's frontend is built on SDK 2 and Quill's app starter (PER-291). `defineReactApp` mounts it, its picker for `aim.pick` and its card on Home; its places (`/`, `/yours`, `/intents/:id`) are on TanStack Router through `placeRoutes`, so the address bar, Back and Forward follow it; what it loads is kept per floor with `useData` and loaded again when its service publishes a change; and it calls its service with `createAppClient`, checked against the routes in `service/src/api-types.ts`. Its manifest now asks for SDK 2 (`^2.0.0`), since it needs the kit a 2.0 shell serves.
