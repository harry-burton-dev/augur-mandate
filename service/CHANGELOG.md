# @apps/mandate

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
