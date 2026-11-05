---
'@apps/mandate': patch
---

Mandate's manifest says it binds intents to entities (`links.entities`, `bindings: ["intent"]`, SDK 2.1), so Data Atlas finds its binding events through the registry rather than a list in its own code. It needs AUGUR 0.22.0 or later, whose registry reads these fields.
