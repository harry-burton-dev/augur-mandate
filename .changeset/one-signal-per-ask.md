---
'@apps/mandate': minor
---

Work that waits in someone's Inbox no longer also sends them a notification that needs them, so it isn't emailed twice (AUGUR's ADR 0090). Passing a part, passing it again, changing it while it waits, issuing the intent above it again and a part needing a holder now send a notification as news beside the Inbox item. Concerns and blocked or achieved ratings still need whoever passed the part down.
