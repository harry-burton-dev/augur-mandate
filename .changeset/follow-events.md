---
'@apps/mandate': minor
'@apps/mandate-frontend': minor
---

Mandate follows what happens around it. When someone holding a part is signed out for good, leaves, or leaves the team whose floor the part is on, the part shows **Needs a holder**, and whoever passed it down is asked in their Inbox to pass it again (**Pass it again**, `POST /intents/:id/pass-again`). Leads of the floor above can do it too. If the person is signed back in before then, the part is theirs again. A renamed team's floor shows its new name. An entity Data Atlas retires is shown as retired, and one it merges into another moves to the survivor, then back if the merge is split. Bindings are published through the service kit's binding helper (ADR 0066). The app needs the `events:subscribe` scope, and an admin allows it in Admin, Apps.
