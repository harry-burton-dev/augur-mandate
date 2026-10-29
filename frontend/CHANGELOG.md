# @apps/mandate-frontend

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
