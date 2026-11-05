import { callerHeaders, type CallerWorkspace, type InboxChange, type NewInboxItem } from '@augur/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import type { MandateInbox } from '../inbox.ts';
import type { People } from '../people.ts';
import { PgMandateStore, type MandateStore } from '../store.ts';
import { addDays, addWorkingDays, dayIn, nextAfter, ruleOf, ruleProblem } from './rules.ts';
import { PgReminderStore, type ReminderStore } from './store.ts';
import { sweepReminders } from './sweep.ts';

describe('rhythms as rules (ADR 0061)', () => {
  it('keeps what an intent already meant: every rhythmDays days', () => {
    expect(ruleOf({ rhythmDays: 7 })).toBe('FREQ=DAILY;INTERVAL=7');
    expect(ruleOf({ rhythmDays: 7, rhythm: 'FREQ=WEEKLY;BYDAY=MO' })).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('takes a rule that repeats at most daily, and says why it won’t take others', () => {
    expect(ruleProblem('FREQ=WEEKLY;BYDAY=MO')).toBeUndefined();
    expect(ruleProblem('RRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO,TU,WE,TH,FR')).toBeUndefined();
    expect(ruleProblem('FREQ=HOURLY')).toMatch(/at most once a day/);
    expect(ruleProblem('DTSTART:20261101T000000Z\nRRULE:FREQ=DAILY')).toMatch(/DTSTART/);
    expect(ruleProblem('every monday')).toMatch(/can read/);
    expect(ruleProblem(' ')).toMatch(/Say how often/);
  });

  it('works out the next time in the organisation’s time zone', () => {
    const wednesday = new Date('2026-11-04T10:00:00Z');
    expect(nextAfter('FREQ=DAILY;INTERVAL=7', wednesday, 'UTC')?.toISOString()).toBe('2026-11-11T10:00:00.000Z');
    // Monday, at the same time of day there: London is on GMT, New York five hours behind.
    expect(nextAfter('FREQ=WEEKLY;BYDAY=MO', wednesday, 'Europe/London')?.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    expect(nextAfter('FREQ=WEEKLY;BYDAY=MO', wednesday, 'America/New_York')?.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    // Late on Sunday in UTC is already Monday in Tokyo, so the next Monday there is a week on.
    expect(nextAfter('FREQ=WEEKLY;BYDAY=MO', new Date('2026-11-08T20:00:00Z'), 'Asia/Tokyo')?.toISOString()).toBe('2026-11-15T20:00:00.000Z');
    expect(dayIn('Europe/Berlin', new Date('2026-11-05T23:30:00Z'))).toBe('2026-11-06');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

const ORG = 'w-org';
const ENG = 'w-eng';
const folk = [
  { id: 'okafor', name: 'R. Okafor', teams: [] as string[] },
  { id: 'dana', name: 'Dana Ross', teams: [ENG] },
  { id: 'sam', name: 'Sam Patel', teams: [ENG] },
];
const people: People = {
  principals: async (person) => {
    const p = folk.find((f) => f.id === person);
    return [`person:${person}`, ...(p?.teams ?? []).flatMap((t) => [`team:${t}`, `tree:${t}`]), 'org'];
  },
  directory: async ({ ids }) => ({
    people: folk.filter((p) => !ids || ids.includes(p.id)).map(({ id, name }) => ({ id, name })),
    teams: [{ id: ENG, name: 'Engineering', within: [], path: [ENG] }].filter((t) => !ids || ids.includes(t.id)),
  }),
  audience: async () => [],
};
const on = (person: string, workspace: CallerWorkspace) => callerHeaders({ id: person, name: folk.find((f) => f.id === person)!.name, departments: [], roles: [], workspace });
const orgLead = on('okafor', { id: ORG, kind: 'org', role: 'lead' });
const engLead = on('dana', { id: ENG, kind: 'team', role: 'lead' });

type Kept = { workspace: string; item: NewInboxItem; state: 'open' | 'done' | 'withdrawn'; changes: InboxChange[] };

const setup = async (store: MandateStore, reminders: ReminderStore) => {
  // The shell's Inbox, as Mandate puts work there: each item by key, as it stands.
  const inbox = new Map<string, Kept>();
  let broken = false;
  const work: MandateInbox = {
    put: async (key, workspace, item) => {
      if (broken) throw new Error('The events service is down.');
      inbox.set(key, { workspace, item, state: 'open', changes: [] });
    },
    close: async (key, state) => void (inbox.has(key) && (inbox.get(key)!.state = state)),
    change: async (key, change) => {
      if (broken) throw new Error('The events service is down.');
      inbox.get(key)?.changes.push(change);
    },
  };
  let clock = new Date('2026-10-27T09:00:00Z');
  const app = await buildApp({ store, people, inbox: work, notify: async () => {}, audit: async () => {}, now: () => clock });
  const call = async (headers: Record<string, string>, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const sweep = (at: string, zone = 'UTC') => sweepReminders({ store: reminders, inbox: work, zone: async () => zone, app: 'mandate', now: () => new Date(at) });
  return {
    inbox,
    call,
    sweep,
    at: (when: string) => void (clock = new Date(when)),
    breakInbox: (yes: boolean) => void (broken = yes),
  };
};

/** Operation Alpha, issued on the org floor, with a part passed to Engineering to back-brief by 29 October. */
const alpha = async ({ call }: Awaited<ReturnType<typeof setup>>) => {
  const op = (await call(orgLead, 'POST', '/intents', { title: 'Operation Alpha', floorName: 'Northwind' })).body;
  await call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { purpose: 'Ardel runs out of fuel without it.', endState: 'Ardel stocked for 30 days.' } });
  await call(orgLead, 'POST', `/intents/${op.id}/issue`);
  const part = (await call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${ENG}`, title: 'Keep Halcyon at sea', briefBy: '2026-10-29' })).body;
  return { op, part };
};

const reminds = (make: () => Promise<{ store: MandateStore; reminders: ReminderStore }>) => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    const { store, reminders } = await make();
    t = await setup(store, reminders);
  });

  it('keeps the back-brief-by date on the part and its Inbox item', async () => {
    const { part } = await alpha(t);
    expect(part.briefBy).toBe('2026-10-29');
    expect(t.inbox.get(`back-brief/${part.id}`)?.item).toMatchObject({ kind: 'back-brief', due: '2026-10-29', owner: { kind: 'team', id: ENG, role: 'lead' } });
    expect((await t.call(engLead, 'GET', `/intents/${part.id}`)).body.intent.briefBy).toBe('2026-10-29');
  });

  it('reminds the holder the day before, and holder and giver once it’s late, each once', async () => {
    const { part } = await alpha(t);
    expect(await t.sweep('2026-10-27T10:00:00Z')).toEqual({ sent: 0, closed: 0, failed: 0 });

    expect((await t.sweep('2026-10-28T08:00:00Z')).sent).toBe(1);
    expect(t.inbox.get(`back-brief/${part.id}`)?.changes).toEqual([{ detail: 'Back-brief Keep Halcyon at sea by tomorrow. Say it back in your own words to accept it.', due: '2026-10-29' }]);
    expect((await t.sweep('2026-10-28T08:15:00Z')).sent).toBe(0);

    expect((await t.sweep('2026-10-30T08:00:00Z')).sent).toBe(1);
    expect(t.inbox.get(`back-brief/${part.id}`)?.changes.at(-1)?.detail).toBe('Keep Halcyon at sea is waiting for its back-brief. Say it back in your own words to accept it.');
    expect(t.inbox.get(`late-back-brief/${part.id}`)).toMatchObject({
      workspace: ENG,
      state: 'open',
      item: { kind: 'late-back-brief', owner: { kind: 'person', id: 'okafor' }, detail: 'Keep Halcyon at sea is waiting for its back-brief from Engineering.', due: '2026-10-29', path: `/intents/${part.id}` },
    });
    expect((await t.sweep('2026-10-31T08:00:00Z')).sent).toBe(0);

    // The back-brief comes in: the giver's item is taken back on the next sweep.
    t.at('2026-10-31T09:00:00Z');
    expect((await t.call(engLead, 'POST', `/intents/${part.id}/back-brief`, { words: 'Halcyon stays at sea.', outcome: 'accepted' })).status).toBe(200);
    expect(await t.sweep('2026-10-31T09:15:00Z')).toEqual({ sent: 0, closed: 1, failed: 0 });
    expect(t.inbox.get(`late-back-brief/${part.id}`)?.state).toBe('done');
    expect((await t.sweep('2026-10-31T09:30:00Z')).closed).toBe(0);
  });

  it('works the day out in the organisation’s time zone', async () => {
    await alpha(t);
    // 15:30 UTC on 28 October is already the 29th in Tokyo: due today there, not tomorrow.
    await t.sweep('2026-10-28T15:30:00Z', 'Asia/Tokyo');
    const [change] = [...t.inbox.values()].flatMap((k) => k.changes);
    expect(change?.detail).toMatch(/by today/);
  });

  it('asks the holder how it’s going when its rhythm comes round, once, and takes it back once they say', async () => {
    const { part } = await alpha(t);
    t.at('2026-10-28T09:00:00Z');
    await t.call(engLead, 'POST', `/intents/${part.id}/back-brief`, { words: 'Halcyon stays at sea.', outcome: 'accepted' });
    // Passed on 27 October, never assessed, every 7 days: due on 3 November.
    expect((await t.sweep('2026-11-03T08:45:00Z')).sent).toBe(0);
    // Operation Alpha too: made the same morning, never assessed, on the same rhythm.
    expect((await t.sweep('2026-11-03T09:15:00Z')).sent).toBe(2);
    expect(t.inbox.get(`check-in/${part.id}`)).toMatchObject({
      state: 'open',
      item: { kind: 'check-in', owner: { kind: 'team', id: ENG, role: 'lead' }, detail: 'How is Keep Halcyon at sea going? Nothing said yet.', reopen: true, due: '2026-11-03T09:00:00.000Z' },
    });
    expect((await t.sweep('2026-11-03T09:30:00Z')).sent).toBe(0);

    t.at('2026-11-04T09:00:00Z');
    expect((await t.call(engLead, 'POST', `/intents/${part.id}/assess`, { rating: 'on_track' })).status).toBe(200);
    expect(await t.sweep('2026-11-04T09:15:00Z')).toEqual({ sent: 0, closed: 1, failed: 0 });
    expect(t.inbox.get(`check-in/${part.id}`)?.state).toBe('done');

    // A week after it was last said, it comes round again.
    expect((await t.sweep('2026-11-12T09:15:00Z')).sent).toBe(1);
    expect(t.inbox.get(`check-in/${part.id}`)).toMatchObject({ state: 'open', item: { detail: 'How is Keep Halcyon at sea going? Last said 8 days ago.' } });
  });

  it('follows a rhythm its holder chose, and refuses one that repeats more than daily', async () => {
    const { part } = await alpha(t);
    t.at('2026-10-28T09:00:00Z');
    await t.call(engLead, 'POST', `/intents/${part.id}/back-brief`, { words: 'Halcyon stays at sea.', outcome: 'accepted' });
    expect((await t.call(engLead, 'GET', `/intents/${part.id}`)).body.rhythm).toBe('FREQ=DAILY;INTERVAL=7');
    const hourly = await t.call(engLead, 'PATCH', `/intents/${part.id}`, { rhythm: 'FREQ=HOURLY' });
    expect(hourly).toMatchObject({ status: 400, body: { reason: 'bad-rhythm' } });
    expect((await t.call(engLead, 'PATCH', `/intents/${part.id}`, { rhythm: 'rrule:freq=weekly;byday=fr' })).body.rhythm).toBe('FREQ=WEEKLY;BYDAY=FR');
    // Passed on Tuesday 27 October: the first Friday after is the 30th.
    expect((await t.sweep('2026-10-30T09:15:00Z')).sent).toBe(1);
    expect((await t.call(engLead, 'PATCH', `/intents/${part.id}`, { rhythm: null })).body.rhythm).toBe('FREQ=DAILY;INTERVAL=7');
  });

  it('tries again on the next sweep when the Inbox can’t be reached', async () => {
    const { part } = await alpha(t);
    t.breakInbox(true);
    expect(await t.sweep('2026-10-28T08:00:00Z')).toEqual({ sent: 0, closed: 0, failed: 1 });
    t.breakInbox(false);
    expect((await t.sweep('2026-10-28T08:15:00Z')).sent).toBe(1);
    expect(t.inbox.get(`back-brief/${part.id}`)?.changes).toHaveLength(1);
  });

  it('reminds whoever passed a part down of a concern waiting two working days, once, and takes it back once answered', async () => {
    const { part } = await alpha(t);
    // Raised on Thursday 29 October: two working days on is Monday 2 November, past the weekend.
    t.at('2026-10-29T16:00:00Z');
    const raised = await t.call(engLead, 'POST', `/intents/${part.id}/back-brief`, { words: 'Keep Halcyon at sea.', concern: 'Halcyon is due in dock on the 3rd.', outcome: 'concern' });
    expect(raised.status).toBe(200);
    await t.sweep('2026-10-31T09:00:00Z');
    expect(t.inbox.has(`concern/${part.id}`)).toBe(false);
    await t.sweep('2026-11-02T08:00:00Z');
    expect(t.inbox.get(`concern/${part.id}`)).toMatchObject({
      workspace: ORG,
      state: 'open',
      item: { kind: 'concern', owner: { kind: 'person', id: 'okafor' }, detail: 'Dana Ross’s concern on Keep Halcyon at sea is waiting for your answer.', due: '2026-11-02', path: `/intents/${part.id}#discussion` },
    });
    const sent = await t.sweep('2026-11-02T08:15:00Z');
    expect(sent.sent).toBe(0);

    t.at('2026-11-02T10:00:00Z');
    const ref = { kind: 'ref', app: 'mandate', type: 'intent', id: part.id };
    expect((await t.call(orgLead, 'POST', '/threads/messages', { ref, kind: 'answer', words: 'Dock her on the 10th instead.' })).status).toBe(201);
    expect((await t.sweep('2026-11-02T10:15:00Z')).closed).toBe(1);
    expect(t.inbox.get(`concern/${part.id}`)?.state).toBe('done');
    expect((await t.sweep('2026-11-02T10:30:00Z')).closed).toBe(0);
  });

  it('counts working days, Monday to Friday, in the organisation’s days', () => {
    expect(addWorkingDays('2026-10-29', 2)).toBe('2026-11-02');
    expect(addWorkingDays('2026-10-31', 2)).toBe('2026-11-03');
    expect(addWorkingDays('2026-11-02', 2)).toBe('2026-11-04');
  });

  it('reminds nobody about a part someone holds for themselves when they passed it', async () => {
    const op = (await t.call(orgLead, 'POST', '/intents', { title: 'Own work' })).body;
    await t.call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { purpose: 'p', endState: 'e' } });
    await t.call(orgLead, 'POST', `/intents/${op.id}/issue`);
    const mine = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: 'person:okafor', title: 'Do it myself', briefBy: '2026-10-28' })).body;
    expect((await t.sweep('2026-10-30T08:00:00Z')).sent).toBe(1);
    expect(t.inbox.has(`late-back-brief/${mine.id}`)).toBe(false);
  });
};

// On a database of its own, made beside DATABASE_URL's, so Mandate's other tests can use that one at the same time.
describe.runIf(process.env.DATABASE_URL)('reminders on Postgres', () => {
  const name = 'mandate_reminders_test';
  let admin: pg.Pool;
  let db: pg.Pool;
  let store: PgMandateStore;
  let reminders: PgReminderStore;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    db = new pg.Pool({ connectionString: url.toString() });
    store = await PgMandateStore.connect(url.toString());
    reminders = PgReminderStore.connect(url.toString());
  });
  afterAll(async () => {
    await reminders.close();
    await store.close();
    await db.end();
    // Left for the next run's beforeAll to drop: dropping it here, with force, can cut a connection that is
    // still closing, which then throws outside any test.
    await admin.end();
  });
  reminds(async () => {
    await db.query('truncate mandate.messages, mandate.outbox, mandate.entity_bindings, mandate.document_bindings, mandate.assessments, mandate.back_briefs, mandate.versions, mandate.intents');
    return { store, reminders };
  });
});
