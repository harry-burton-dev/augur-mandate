# @apps/mandate-frontend

## 0.3.0

### Minor Changes

- 3d31611: Closing an intent with parts still open below it now asks what happens to them. **Close them too** keeps the old behaviour and stays the default. **Let them stand alone** makes each part directly below the head of its own tree, with its own parts still under it. Each keeps its holder, statement and bindings. What a part carried down is labelled "(no longer above)", and its history says it stood alone. `POST /intents/:id/achieve` and `/withdraw` take `parts: 'close' | 'stand-alone'`, and the change publishes `mandate.intent.stood-alone`.
- 969697b: Each part in Mandate has a **Discussion**. Whoever holds the part raises concerns and leaves notes there. Whoever passed it down answers concerns and leaves notes, and each side is told when the other writes. A concern raised while back-briefing also starts the discussion, so the whole exchange is in one place. While a part waits for its back-brief, whoever passed it down can **Change what you passed**: the change is issued as the next version, the holder is asked to say it back again, and the change answers the concern that was waiting. A closed intent's discussion stays readable, but nobody can write in it. Someone who sees a part only as a summary can't read its discussion.

  Also fixed: passing a part again to a team below now moves it to that team's floor when Mandate keeps its data in Postgres. Before, the part's floor wasn't saved.

- 72be5db: Mandate follows what happens around it. When someone holding a part is signed out for good, leaves, or leaves the team whose floor the part is on, the part shows **Needs a holder**, and whoever passed it down is asked in their Inbox to pass it again (**Pass it again**, `POST /intents/:id/pass-again`). Leads of the floor above can do it too. If the person is signed back in before then, the part is theirs again. A renamed team's floor shows its new name. An entity Data Atlas retires is shown as retired, and one it merges into another moves to the survivor, then back if the merge is split. Bindings are published through the service kit's binding helper (ADR 0066). The app needs the `events:subscribe` scope, and an admin allows it in Admin, Apps.
- e928f0e: Reminders on time (ADR 0061, part of PER-239). Passing a part down asks when to back-brief it by, three days ahead unless you change it. Every 15 minutes a sweep puts what has come due in the Inbox, once each:

  - The day before, the holder's back-brief item says so.
  - Once it's late, the holder's item says so, and whoever passed it down gets "Waiting for a back-brief".
  - When an intent's rhythm comes round, its holder gets "How it's going".

  A rhythm can now be an RFC 5545 rule, such as `FREQ=WEEKLY;BYDAY=MO`, through `PATCH /intents/:id` `rhythm`. Without one, the intent is asked every `rhythmDays` days, as before. Two new Inbox kinds are in the manifest, and there is a new migration, `003_reminders`.

- aee752e: Mandate's frontend is built on SDK 2 and Quill's app starter (PER-291). `defineReactApp` mounts it, its picker for `aim.pick` and its card on Home; its places (`/`, `/yours`, `/intents/:id`) are on TanStack Router through `placeRoutes`, so the address bar, Back and Forward follow it; what it loads is kept per floor with `useData` and loaded again when its service publishes a change; and it calls its service with `createAppClient`, checked against the routes in `service/src/api-types.ts`. Its manifest now asks for SDK 2 (`^2.0.0`), since it needs the kit a 2.0 shell serves.

## 0.2.3

### Patch Changes

- 7f21a10: The wire types between the frontend and the service are written once, in the service's src/api-types.ts, and both sides use them. Types only: the frontend bundle and the service build don't change.

## 0.2.2

### Patch Changes

- e082ef2: Mandate is released from its own repository now, signed by this repository's release workflow. Nothing changes for people using it.

## 0.2.1

### Patch Changes

- Updated dependencies [9e021dd]
  - @augur/app-kit@0.3.0

## 0.2.0

### Minor Changes

- 527a413: Mandate is on React and Quill (PER-243): the floor's intents, what you hold, one intent with its statement, line of sight, parts below and what it's bound to, its dialogs, the picker other apps open with `aim.pick` and its card on Home. The words, limits and behaviour are the same as before; it no longer uses the Lit kit. Quill's `Editor` and `DateField` take a `defaultValue` for when they keep their own value.

### Patch Changes

- Updated dependencies [527a413]
- Updated dependencies [f8e9b46]
- Updated dependencies [da54ae3]
- Updated dependencies [7c8027d]
- Updated dependencies [d500567]
- Updated dependencies [a8854e2]
- Updated dependencies [fccb126]
- Updated dependencies [d64d724]
  - @augur/app-kit@0.2.0
  - @augur/mfe-sdk@1.10.0

## 0.1.5

### Patch Changes

- Updated dependencies [2a05a51]
- Updated dependencies [4c1bb55]
- Updated dependencies [5ab5009]
  - @augur/ui-kit@1.8.0
  - @augur/mfe-sdk@1.9.0

## 0.1.4

### Patch Changes

- Updated dependencies [bb91780]
- Updated dependencies [bef7098]
- Updated dependencies [e0e9c83]
  - @augur/mfe-sdk@1.8.0
  - @augur/ui-kit@1.7.0

## 0.1.3

### Patch Changes

- Updated dependencies [5b2c80c]
  - @augur/mfe-sdk@1.7.0

## 0.1.2

### Patch Changes

- effebfe: App kit, part 2: the frame. New `ui-app-frame` (the slate ground, a rail, the main column and an aside), `ui-page-head` (the trail of what a page is inside, its title, one line of summary, and two actions with the rest in ⋯) and `ui-section` (a labelled part with its count, one action and a why, folding after five). New token `measure-rail` (240px). Type tokens are now emitted in rem, so a person's browser text size scales them. Artifacts, Mandate, Data Atlas and Auspex use the frame and page head instead of their own grids, heads and trails.
- 84fab17: App kit, part 3: more at a glance. New `ui-card` and `ui-cards` (one thing in a grid, its floor shown as a dot and a name, with at most one line that matters; unavailable cards stay and say why), `ui-tally` (counts as segments, saying only what needs attention), `ui-details` (label and value, unknowns said, folding after eight), `ui-timeline` (history grouped by day in words) and `ui-path` (line of sight down the floors). Mandate's intent cards drop the coloured edge stripe for the floor dot and gain a tally of the parts below; its line of sight and history use `ui-path` and `ui-timeline`. Data Atlas shows an entity's, a fact's and an observation's details with `ui-details`.
- 2c9caf0: App kit, part 1: nothing is obtuse. `ui-button` and `ui-icon-button` take a `reason`: disabled with one, they stay focusable and say why on hover and focus, and it's read aloud. List rows, list actions and menu entries take a `reason` too. The kit warns on localhost about a disabled control without one, and `pnpm check:reasons` fails a platform screen that has one. New parts: `ui-notice` (one sentence that needs attention, with one action), `ui-note` (a quiet line with its `why` one press away) and `ui-can` (what you can do here, and who can do the rest). Every disabled control in Admin, the shell, Artifacts, Mandate and Data Atlas now says why, and ones that were only waiting for a request show as busy instead.
- b716037: App kit, part 4: references. New `ui-ref` (a thing from any app as a chip: its kind's icon, its name, a floor dot when it's kept on another floor; it opens where you are, and can be removed) and `ui-refs` (a row of them, counting the ones you can't open with where they're kept and who to ask). Mandate's bound entities and context documents, and Data Atlas's links in the explorer and Triage's outcome, use them instead of underlined text buttons.
- 2487ae0: App kit, part 5: the writing kit. New `ui-date` (a day said and typed in words, with quick choices and the calendar one press away), `ui-people-picker` (people and teams by name; ones that can't be added stay and say why), `ui-editor` (Markdown without a toolbar at rest: a bar on a selection, Ctrl B and Ctrl I, `@` and `#` mentions saved as references, and a soft length guide) and `ui-prose` (shows what the editor writes, safely). Data Atlas's seven date fields and Mandate's "Done by" use `ui-date`, and Mandate says its dates in words. Artifacts' share dialog finds people with `ui-people-picker`. Mandate's statement, back-brief and concern are written in `ui-editor` and shown with `ui-prose`. Timeline days with a year no longer carry a stray comma.
- Updated dependencies [effebfe]
- Updated dependencies [84fab17]
- Updated dependencies [2c9caf0]
- Updated dependencies [b716037]
- Updated dependencies [2487ae0]
  - @augur/ui-kit@1.6.0

## 0.1.1

### Patch Changes

- Updated dependencies [d68128b]
- Updated dependencies [7ee3531]
- Updated dependencies [d52bfce]
- Updated dependencies [a9cfcf7]
  - @augur/ui-kit@1.5.0
  - @augur/mfe-sdk@1.6.0

## 0.1.0

### Minor Changes

- f01fcea: Mandate, the intent pillar app (alpha). Set intent on a floor in the shape allied orders use (mission, purpose, end state, key tasks, constraints, restraints, freedoms), pass parts of it down to the teams below or people on the floor, and have each holder say it back before it's theirs. Holders say how it's going on a rhythm; whoever passed it down closes it. Intents bind Data Atlas entities and documents as context, which flows down the tree. Answers `aim.open` and `aim.pick` so other apps (a briefing tool, say) can open an intent or bound what they gather to one.

### Patch Changes

- 524a9b0: Mandate binds entities through the SDK's shared entity contract (`pickEntities`, `openEntity`, `EntityRef`) instead of its own copies, and takes an entity sent without a label.
- 1580b6b: Menu icons no longer repeat what they sit under: each app's menu group and first page now have their own icon instead of the app's.
- Updated dependencies [1580b6b]
- Updated dependencies [d324552]
- Updated dependencies [18bf27c]
- Updated dependencies [f01fcea]
- Updated dependencies [8f69cb5]
- Updated dependencies [b556614]
- Updated dependencies [513e2e9]
- Updated dependencies [feeffdd]
- Updated dependencies [ae92eed]
- Updated dependencies [778b6f9]
- Updated dependencies [513e2e9]
- Updated dependencies [28d8775]
  - @augur/mfe-sdk@1.5.0
  - @augur/ui-kit@1.4.0
