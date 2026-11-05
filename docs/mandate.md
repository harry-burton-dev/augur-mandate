# Mandate: the guide

Mandate holds **intent**: what a floor means to achieve and why, and the parts of it passed down to the
teams and people who'll do it. Each part is said back in the holder's own words (a back-brief) before it
counts as accepted. This guide covers what people do in Mandate, what an admin allows for it, and what it
tells the rest of AUGUR. AUGUR's own guide to it is `docs/mandate.md` in the `augur` repository.

## What people do

**Issue an intent.** A floor's leads write an intent: its purpose, the end state, key tasks and a date to
achieve it by. Issuing it makes it the floor's.

**Pass a part down.** Whoever holds an intent passes parts of it to a person, a team below, or themselves,
with a date to back-brief by. The part waits in the holder's Inbox ("To say back") until they say it back.

**Say it back, or raise a concern.** The holder writes the part back in their own words and accepts it, or
says what doesn't fit. A concern starts the part's discussion.

**Discuss it.** Every intent has a discussion, under **Discussion** on its page (`#discussion`). Whoever
holds a part writes notes and raises concerns; whoever passed it down writes notes and, while a concern
waits, answers it. A concern not yet answered shows "Waiting for an answer from *name*". Readers who see
the intent in full read it; nobody else does, so siblings don't read each other's discussion. An ended
intent's discussion is closed and says so.

**Change what was passed.** While a part waits for its back-brief, whoever passed it down can change its
title, why it matters and what it carries. That issues the next version, answers a waiting concern with
the change, and asks the holder to say it back again. Once a part is accepted it can't be changed this way:
its giver changes their own intent, and the holder is asked to confirm theirs still fits.

**Say how it's going.** The holder rates an intent on track, at risk or blocked, as often as its rhythm
asks (see Reminders).

**Close it with a choice.** Achieving or withdrawing an intent with parts still open asks what becomes of
them: close them too (closed with it when it's achieved, withdrawn when it's withdrawn), or let them stand alone. A part
that stands alone keeps going on its own floor; its page says which intent it came from and when it was
let stand alone, and the history records it.

### When a holder can't hold a part

Mandate follows the platform (the `events:subscribe` scope):

| What happens | What Mandate does |
| --- | --- |
| Someone's sign-in is turned off | Each open part passed to them is marked **Needs a holder**, and whoever passed it down is asked, in their Inbox ("To pass again"), to pass it again or withdraw it. With no giver, the leads of the floor above are asked |
| Their sign-in is turned back on | What nobody has taken on is theirs again; the Inbox item is taken back |
| Someone leaves | As for a sign-in turned off. A handover named when they left is suggested in the item, never passed on unasked |
| Someone leaves a team | Only the parts passed to them on that team's floor need a holder; what they hold elsewhere stays theirs |
| A team is renamed | Its floor's intents show the new name |
| Data Atlas retires an entity | Its chips on intents say "(retired in Data Atlas)" |
| Data Atlas merges an entity | Its bindings move to the survivor, saying where they came from; a split moves them back |

## Reminders

A sweep runs every 15 minutes, once across every instance, and puts what has come due in the Inbox
(AUGUR's ADR 0026). Each is sent once:

| When | Who | What they see |
| --- | --- | --- |
| The day before a part's back-brief-by date | Its holder | "Back-brief *title* by tomorrow" on their back-brief item |
| The back-brief is late | Its holder, and whoever passed it down | The holder's item says it's waiting; the giver gets "Waiting for a back-brief", taken back once it comes in |
| An intent's rhythm comes round | Its holder | "How it's going", taken back once they say |
| A concern has waited two working days for an answer | Whoever passed the part down (else the leads of the floor above) | "*Name*'s concern on *title* is waiting for your answer" ("Concerns to answer"), taken back once it's answered or the part ends |

A rhythm is an RFC 5545 rule without DTSTART, such as `FREQ=WEEKLY;BYDAY=MO` (AUGUR's ADR 0061). It repeats
at most daily. An intent without one is asked every `rhythmDays` days. Days, rules and working days are
worked out in the organisation's time zone, which comes from identity (UTC when it can't say). Working
days are Monday to Friday: AUGUR has no setting for an organisation's working week yet.

## For admins

Mandate ships with AUGUR as the `mandate` container. In **Admin → Apps**, allow its scopes:

| Scope | What it's for |
| --- | --- |
| `audit:write` | Records who did what to an intent |
| `people:read` | Names, teams and who leads them |
| `notifications:send` | Tells people what changed |
| `events:publish` | Tells other apps (the events below) |
| `events:subscribe` | Follows the platform and Data Atlas (When a holder can't hold a part). Without it nothing is followed: a part held by someone who has left stays theirs |
| `inbox:write` | Puts work and reminders in people's Inbox |

To check following works after an upgrade: pass a part to a test person, turn their sign-in off in Admin,
and see the part marked **Needs a holder** and the item in your Inbox; turn it back on and see both go.

## What Mandate tells other apps

Each event's payload carries `intent`, the intent's id, and goes to the intent's workspace.

| Topic | When |
| --- | --- |
| `mandate.intent.issued` | An intent is issued |
| `mandate.intent.passed` | A part is passed down, or passed again |
| `mandate.intent.accepted` | A part is said back and accepted |
| `mandate.intent.assessed` | Someone says how it's going |
| `mandate.intent.achieved`, `mandate.intent.withdrawn` | It ends |
| `mandate.intent.superseded` | An open part closes because the intent above it was achieved |
| `mandate.intent.entity-bound` | An entity is bound or unbound, in ADR 0066's shape (`{ intent, entity, role }`) |
| `mandate.intent.needs-holder` | A part's holder can no longer hold it (`why`: `disabled`, `left`, `removed`) |
| `mandate.intent.discussed` | A message is written in its discussion (`message`, `kind`) |
| `mandate.intent.stood-alone` | A part is let stand alone when the intent above it closes |

## The API

Through the gateway at `/api/mandate/v1`. Wire types are written once, in `service/src/api-types.ts`
(`MandatePaths`).

| Route | What it does |
| --- | --- |
| `GET /floor`, `GET /me`, `GET /home`, `GET /search` | The floor's intents, yours, the Home card, search |
| `POST /intents`, `GET`/`PATCH /intents/:id` | Make, read and change an intent |
| `POST /intents/:id/issue` | Issue it |
| `GET /intents/:id/targets`, `POST /intents/:id/pass` | Who a part can go to, and pass it |
| `POST /intents/:id/back-brief` | Say it back: `accepted`, or `concern` with what doesn't fit |
| `PATCH /intents/:id/passed` | The giver changes a part still waiting for its back-brief |
| `POST /intents/:id/pass-again` | The giver passes a part that needs a holder to someone else |
| `GET /threads?app=mandate&type=intent&id=…` | An intent's discussion and what the reader may write (ADR 0028) |
| `POST /threads/messages` | Write a `concern`, `answer` or `note` |
| `POST /intents/:id/assess` | Say how it's going |
| `POST /intents/:id/achieve`, `POST /intents/:id/withdraw` | Close it; `parts` says what becomes of open parts (`close` or `stand-alone`) |
| `POST /intents/:id/main-effort` | Mark the main effort |
| `POST`/`DELETE /intents/:id/entities…`, `POST`/`DELETE /intents/:id/documents…` | Bind entities and documents |
