---
'@apps/mandate': minor
'@apps/mandate-frontend': minor
---

Each part in Mandate has a **Discussion**. Whoever holds the part raises concerns and leaves notes there. Whoever passed it down answers concerns and leaves notes, and each side is told when the other writes. A concern raised while back-briefing also starts the discussion, so the whole exchange is in one place. While a part waits for its back-brief, whoever passed it down can **Change what you passed**: the change is issued as the next version, the holder is asked to say it back again, and the change answers the concern that was waiting. A closed intent's discussion stays readable, but nobody can write in it. Someone who sees a part only as a summary can't read its discussion.

Also fixed: passing a part again to a team below now moves it to that team's floor when Mandate keeps its data in Postgres. Before, the part's floor wasn't saved.
