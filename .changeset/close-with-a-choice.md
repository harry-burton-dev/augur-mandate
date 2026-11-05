---
'@apps/mandate': minor
'@apps/mandate-frontend': minor
---

Closing an intent with parts still open below it now asks what happens to them. **Close them too** keeps the old behaviour and stays the default. **Let them stand alone** makes each part directly below the head of its own tree, with its own parts still under it. Each keeps its holder, statement and bindings. What a part carried down is labelled "(no longer above)", and its history says it stood alone. `POST /intents/:id/achieve` and `/withdraw` take `parts: 'close' | 'stand-alone'`, and the change publishes `mandate.intent.stood-alone`.
