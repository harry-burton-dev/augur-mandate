---
'@apps/mandate': minor
'@apps/mandate-frontend': minor
---

Reminders on time (ADR 0061, part of PER-239). Passing a part down asks when to back-brief it by, three days ahead unless you change it. Every 15 minutes a sweep puts what has come due in the Inbox, once each:

- The day before, the holder's back-brief item says so.
- Once it's late, the holder's item says so, and whoever passed it down gets "Waiting for a back-brief".
- When an intent's rhythm comes round, its holder gets "How it's going".

A rhythm can now be an RFC 5545 rule, such as `FREQ=WEEKLY;BYDAY=MO`, through `PATCH /intents/:id` `rhythm`. Without one, the intent is asked every `rhythmDays` days, as before. Two new Inbox kinds are in the manifest, and there is a new migration, `003_reminders`.
