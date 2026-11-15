# @apps/mandate

## 0.3.0

### Minor Changes

- fa044b4: The manifest says what kind of app this is (ADR 0032): a pillar app: part of the foundation of what AUGUR produces. Needs SDK 1.11 or later, the first that knows the kind, so an older AUGUR refuses it with a reason instead of failing to register it.
- 84758fe: Mandate starts with the service kit's app-service starter: its settings are checked before it starts (in production a missing one stops it, saying which), it runs jobs on the service kit's jobs engine, and it registers, gives its frontend and shuts down the one way every app does. Its schema is brought up to date by the service kit's `runMigrations`, which keeps the same `mandate.migrations` record. Every refusal is now an RFC 9457 problem details body, which still carries `error` and `message` for the frontend.
- 3d31611: Closing an intent with parts still open below it now asks what happens to them. **Close them too** keeps the old behaviour and stays the default. **Let them stand alone** makes each part directly below the head of its own tree, with its own parts still under it. Each keeps its holder, statement and bindings. What a part carried down is labelled "(no longer above)", and its history says it stood alone. `POST /intents/:id/achieve` and `/withdraw` take `parts: 'close' | 'stand-alone'`, and the change publishes `mandate.intent.stood-alone`.
- d563271: A concern that has waited two working days for its answer reminds whoever passed the part down, once, in a new "Concerns to answer" Inbox item that closes once it's answered. Adds migration `006_concern_reminders`. Mandate's guide is now in `docs/mandate.md`.
- 969697b: Each part in Mandate has a **Discussion**. Whoever holds the part raises concerns and leaves notes there. Whoever passed it down answers concerns and leaves notes, and each side is told when the other writes. A concern raised while back-briefing also starts the discussion, so the whole exchange is in one place. While a part waits for its back-brief, whoever passed it down can **Change what you passed**: the change is issued as the next version, the holder is asked to say it back again, and the change answers the concern that was waiting. A closed intent's discussion stays readable, but nobody can write in it. Someone who sees a part only as a summary can't read its discussion.

  Also fixed: passing a part again to a team below now moves it to that team's floor when Mandate keeps its data in Postgres. Before, the part's floor wasn't saved.

- 72be5db: Mandate follows what happens around it. When someone holding a part is signed out for good, leaves, or leaves the team whose floor the part is on, the part shows **Needs a holder**, and whoever passed it down is asked in their Inbox to pass it again (**Pass it again**, `POST /intents/:id/pass-again`). Leads of the floor above can do it too. If the person is signed back in before then, the part is theirs again. A renamed team's floor shows its new name. An entity Data Atlas retires is shown as retired, and one it merges into another moves to the survivor, then back if the merge is split. Bindings are published through the service kit's binding helper (ADR 0066). The app needs the `events:subscribe` scope, and an admin allows it in Admin, Apps.
- 45ec4c6: A part passed down waits in the shell's Inbox of whoever holds it (the person, or the team's leads) until it's said back. It opens again when the intent above is revised, and is taken back when that intent closes first. Needs the `inbox:write` scope, which an admin allows in Admin, Apps.
- 0399446: Work that waits in someone's Inbox no longer also sends them a notification that needs them, so it isn't emailed twice (AUGUR's ADR 0090). Passing a part, passing it again, changing it while it waits, issuing the intent above it again and a part needing a holder now send a notification as news beside the Inbox item. Concerns and blocked or achieved ratings still need whoever passed the part down.
- e928f0e: Reminders on time (ADR 0061, part of PER-239). Passing a part down asks when to back-brief it by, three days ahead unless you change it. Every 15 minutes a sweep puts what has come due in the Inbox, once each:

  - The day before, the holder's back-brief item says so.
  - Once it's late, the holder's item says so, and whoever passed it down gets "Waiting for a back-brief".
  - When an intent's rhythm comes round, its holder gets "How it's going".

  A rhythm can now be an RFC 5545 rule, such as `FREQ=WEEKLY;BYDAY=MO`, through `PATCH /intents/:id` `rhythm`. Without one, the intent is asked every `rhythmDays` days, as before. Two new Inbox kinds are in the manifest, and there is a new migration, `003_reminders`.

### Patch Changes

- f1725b3: Mandate keeps its own entry in the Backstage catalog, `catalog-info.yaml`, written by `augur-app catalog` from the manifest and the package.json files. CI checks it is current, and Version packages rewrites it.
- 15b0420: Mandate's manifest says it binds intents to entities (`links.entities`, `bindings: ["intent"]`, SDK 2.1), so Data Atlas finds its binding events through the registry rather than a list in its own code. It needs AUGUR 0.22.0 or later, whose registry reads these fields.
- c2c98d4: Mandate keeps its intents only in Postgres: its in-memory stores are gone, and its tests run on real Postgres in CI. Under `pnpm dev:app` it needs `DATABASE_URL` (the dev stack's Postgres).
- d702ffd: A `run/` module for AUGUR's run suite: RUN-19 binds an intent to an entity from the seed's cast, checks that Mandate lists it under the entity and that Data Atlas shows it among what uses the entity, then unbinds it and checks both forget it.

## 0.2.3

### Patch Changes

- 7f21a10: The wire types between the frontend and the service are written once, in the service's src/api-types.ts, and both sides use them. Types only: the frontend bundle and the service build don't change.
- 89e9952: The manifest's SDK range also accepts SDK 2. SDK 2 only stops serving Lit, which this app never used, so the
  app keeps opening when a deployment moves to an AUGUR shell built on SDK 2.
- 40ce223: The service stays up when Postgres restarts or drops an idle connection: its database pools log the lost connection (the service kit's `steadyPool`) instead of ending the process (PER-207).

## 0.2.2

### Patch Changes

- e082ef2: Mandate is released from its own repository now, signed by this repository's release workflow. Nothing changes for people using it.

## 0.1.2

### Patch Changes

- Updated dependencies [137791c]
- Updated dependencies [2021f8a]
  - @augur/service-kit@0.11.0

## 0.1.1

### Patch Changes

- Updated dependencies [ea41136]
  - @augur/service-kit@0.10.0

## 0.1.0

### Minor Changes

- f01fcea: Mandate, the intent pillar app (alpha). Set intent on a floor in the shape allied orders use (mission, purpose, end state, key tasks, constraints, restraints, freedoms), pass parts of it down to the teams below or people on the floor, and have each holder say it back before it's theirs. Holders say how it's going on a rhythm; whoever passed it down closes it. Intents bind Data Atlas entities and documents as context, which flows down the tree. Answers `aim.open` and `aim.pick` so other apps (a briefing tool, say) can open an intent or bound what they gather to one.

### Patch Changes

- 524a9b0: Mandate binds entities through the SDK's shared entity contract (`pickEntities`, `openEntity`, `EntityRef`) instead of its own copies, and takes an entity sent without a label.
- Updated dependencies [f0d02e2]
- Updated dependencies [bbdad18]
  - @augur/service-kit@0.9.0
