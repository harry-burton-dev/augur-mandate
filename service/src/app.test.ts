import { callerCheckFor, callerHeaders, callerSigner, PLATFORM_TOPICS, signedCallerHeaders, type CallerWorkspace, type NewInboxItem } from '@augur/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { ATLAS_TOPICS, makeFollower } from './follow.ts';
import type { MandateNotice } from './notices.ts';
import type { People } from './people.ts';
import { MemoryMandateStore, PgMandateStore, TOPICS, type MandateStore, type OutboxEvent } from './store.ts';

// Northwind: the org, with Engineering and Logistics below it, and Hull (a team inside Engineering).
const ORG = 'w-org';
const ENG = 'w-eng';
const LOG = 'w-log';
const HULL = 'w-hull';
const teams = [
  { id: ENG, name: 'Engineering', within: [], path: [ENG] },
  { id: LOG, name: 'Logistics', within: [], path: [LOG] },
  { id: HULL, name: 'Hull', within: ['Engineering'], path: [ENG, HULL] },
];
const folk = [
  { id: 'okafor', name: 'R. Okafor', teams: [] as string[] },
  { id: 'dana', name: 'Dana Ross', teams: [ENG] },
  { id: 'sam', name: 'Sam Patel', teams: [ENG] },
  { id: 'priya', name: 'Priya Shah', teams: [LOG] },
  { id: 'jo', name: 'Jo Lee', teams: [HULL] },
];

/** Identity as Mandate asks it: principals with `tree:` for every team above, and the directory. */
const people: People = {
  principals: async (person) => {
    const p = folk.find((f) => f.id === person);
    const trees = new Set((p?.teams ?? []).flatMap((t) => teams.find((x) => x.id === t)!.path));
    return [`person:${person}`, ...(p?.teams ?? []).map((t) => `team:${t}`), ...[...trees].map((t) => `tree:${t}`), 'org'];
  },
  directory: async ({ q, ids }) => {
    const match = (name: string, id: string) => (ids ? ids.includes(id) : name.toLowerCase().includes((q ?? '').toLowerCase()));
    return { people: folk.filter((p) => match(p.name, p.id)).map(({ id, name }) => ({ id, name })), teams: teams.filter((t) => match(t.name, t.id)) };
  },
  audience: async (principals) => folk.filter((p) => principals.some((pr) => pr === 'org' || p.teams.includes(pr.slice('team:'.length)))).map((p) => p.id),
};

const on = (person: string, workspace: CallerWorkspace) => callerHeaders({ id: person, name: folk.find((f) => f.id === person)?.name ?? person, departments: [], roles: [], workspace });
const orgLead = on('okafor', { id: ORG, kind: 'org', role: 'lead' });
const orgMember = (p: string) => on(p, { id: ORG, kind: 'org', role: 'member' });
const engLead = on('dana', { id: ENG, kind: 'team', role: 'lead' });
const engMember = (p: string) => on(p, { id: ENG, kind: 'team', role: 'member' });
const own = (p: string) => on(p, { id: `w-${p}`, kind: 'personal', role: 'lead' });

const setup = async (store: MandateStore, outbox: () => Promise<OutboxEvent[]>) => {
  const notices: MandateNotice[] = [];
  // The shell's Inbox, as Mandate puts work there: each item by key, as it stands.
  const inbox = new Map<string, { workspace: string; item: NewInboxItem; state: 'open' | 'done' | 'withdrawn' }>();
  let clock = Date.parse('2026-10-27T09:00:00Z');
  const work = { put: async (key: string, workspace: string, item: NewInboxItem) => void inbox.set(key, { workspace, item, state: 'open' }), close: async (key: string, state: 'done' | 'withdrawn') => void (inbox.has(key) && (inbox.get(key)!.state = state)), change: async () => {} };
  const notify = async (n: MandateNotice) => void notices.push(n);
  const now = () => new Date((clock += 1000));
  const app = await buildApp({ store, people, notify, inbox: work, audit: async () => {}, now });
  // What Mandate does with the events it follows, over the same store.
  const follow = makeFollower({ app: { id: 'mandate', name: 'Mandate' }, store, people, notify, inbox: work, audit: async () => {}, now });
  const call = async (headers: Record<string, string>, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const later = (days: number) => (clock += days * 24 * 60 * 60 * 1000);
  return { app, store, notices, inbox, call, later, outbox, follow };
};

/** Operation Alpha on the org floor, issued, with Engineering's part accepted and Sam's part under that. */
const alpha = async (call: Awaited<ReturnType<typeof setup>>['call']) => {
  const op = (await call(orgLead, 'POST', '/intents', { title: 'Operation Alpha', floorName: 'Northwind' })).body;
  await call(orgLead, 'PATCH', `/intents/${op.id}`, {
    statement: { mission: 'Keep the northern route open to Port Ardel', purpose: 'Ardel runs out of fuel without it.', endState: 'Two ships on station; Ardel stocked for 30 days.', keyTasks: ['Keep ships at sea', ' ', 'Stock Ardel'] },
  });
  await call(orgLead, 'POST', `/intents/${op.id}/issue`);
  const eng = (await call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${ENG}`, title: 'Keep Halcyon and Corran at sea', purpose: 'The ships keep the route open.' })).body;
  await call(engLead, 'POST', `/intents/${eng.id}/back-brief`, { words: 'Both ships fit for sea from 20 November.', outcome: 'accepted' });
  const sam = (await call(engLead, 'POST', `/intents/${eng.id}/pass`, { to: 'person:sam', title: 'Refit Halcyon’s port shaft' })).body;
  await call(engMember('sam'), 'POST', `/intents/${sam.id}/back-brief`, { words: 'New bearings fitted by 14 Nov.', outcome: 'accepted' });
  return { op, eng, sam };
};

/** Mandate, the same over every store. */
const behaves = (make: () => Promise<{ store: MandateStore; outbox: () => Promise<OutboxEvent[]> }>) => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    const { store, outbox } = await make();
    t = await setup(store, outbox);
  });

  it('reports healthy', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toMatchObject({ status: 'ok', service: 'mandate', api: 'v1' });
  });

  it('believes only the caller the gateway signed for it, and needs a floor', async () => {
    const gateway = callerSigner();
    const app = await buildApp({ callers: callerCheckFor(gateway, 'mandate'), people });
    const sam = { id: 'sam', name: 'Sam Patel', departments: [], roles: [], workspace: { id: 'w-sam', kind: 'personal' as const, role: 'lead' as const } };
    expect((await app.inject({ remoteAddress: '172.18.0.9', method: 'GET', url: '/v1/floor', headers: await signedCallerHeaders(gateway, sam, 'mandate') })).statusCode).toBe(200);
    expect((await app.inject({ remoteAddress: '172.18.0.9', method: 'GET', url: '/v1/floor', headers: callerHeaders(sam) })).statusCode).toBe(401);
    expect((await t.call(callerHeaders({ ...sam, workspace: undefined }), 'GET', '/floor')).status).toBe(400);
  });

  it('answers a refusal as problem details, named from its manifest', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/floor' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, reason: 'unauthenticated', error: 'unauthenticated', detail: 'Sign in to use Mandate.' });
    const refused = await t.app.inject({ method: 'POST', url: '/v1/intents', headers: engMember('sam'), payload: { title: 'Mine' } });
    expect(refused.json()).toMatchObject({ status: 403, error: 'forbidden', message: expect.any(String) });
  });

  it('lets a floor’s leads set intent there, and anyone on their own floor', async () => {
    expect((await t.call(engMember('sam'), 'POST', '/intents', { title: 'Mine' })).status).toBe(403);
    expect((await t.call(engMember('sam'), 'GET', '/floor')).body.can.create).toBe(false);
    expect((await t.call(own('sam'), 'POST', '/intents', { title: 'Get shaft-work sign-off' })).status).toBe(201);
    const draft = (await t.call(engLead, 'POST', '/intents', { title: 'Winter readiness', floorName: 'Engineering' })).body;
    expect(draft).toMatchObject({ life: 'draft', holder: 'floor', holderName: 'Engineering', version: 0 });
    expect((await t.call(engLead, 'GET', '/floor')).body.drafts.map((d: { title: string }) => d.title)).toEqual(['Winter readiness']);
    // A draft is for its holder: a member on the floor doesn't see it listed.
    expect((await t.call(engMember('sam'), 'GET', '/floor')).body.drafts).toEqual([]);
  });

  it('issues a statement as a version, once it says its purpose and end state', async () => {
    const op = (await t.call(orgLead, 'POST', '/intents', { title: 'Operation Alpha' })).body;
    expect((await t.call(orgLead, 'POST', `/intents/${op.id}/issue`)).body.error).toBe('incomplete');
    await t.call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { purpose: ' Keep Ardel supplied ', endState: 'Ardel stocked', keyTasks: ['a', ' ', 'b'], restraints: 'No ships in dock at once' } });
    const issued = (await t.call(orgLead, 'POST', `/intents/${op.id}/issue`)).body;
    expect(issued.intent).toMatchObject({ life: 'active', version: 1 });
    expect(issued.statement).toMatchObject({ purpose: 'Keep Ardel supplied', keyTasks: ['a', 'b'], restraints: 'No ships in dock at once' });
    // The draft moves on; the issued version stays as it was until the next issue.
    const edited = (await t.call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { purpose: 'Keep Ardel supplied all winter' } })).body;
    expect(edited.statement.purpose).toBe('Keep Ardel supplied');
    expect(edited.draft.purpose).toBe('Keep Ardel supplied all winter');
    expect((await t.call(orgMember('priya'), 'GET', `/intents/${op.id}`)).body.draft).toBeUndefined();
    expect((await t.outbox()).map((e) => e.topic)).toEqual([TOPICS.issued]);
  });

  it('passes parts down the floors, and each is under way only once its holder says it back', async () => {
    const op = (await t.call(orgLead, 'POST', '/intents', { title: 'Operation Alpha' })).body;
    // Nothing can be passed down from a draft.
    expect((await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${ENG}`, title: 'X' })).status).toBe(403);
    await t.call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { purpose: 'p', endState: 'e' } });
    await t.call(orgLead, 'POST', `/intents/${op.id}/issue`);
    // Only to a team directly below, or someone on the floor.
    expect((await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${HULL}`, title: 'X' })).body.error).toBe('bad-target');
    const targets = (await t.call(orgLead, 'GET', `/intents/${op.id}/targets?q=e`)).body;
    expect(targets.teams.map((x: { name: string }) => x.name)).toEqual(['Engineering']);
    const eng = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${ENG}`, title: 'Keep the ships at sea', purpose: 'They keep the route open' })).body;
    expect(eng).toMatchObject({ life: 'passed', floorName: 'Engineering', holder: 'floor' });
    expect(t.notices.at(-1)).toMatchObject({ recipients: ['dana', 'sam'], needsYou: true, link: `/intents/${eng.id}` });
    // A member reads it, but a lead back-briefs for the team.
    expect((await t.call(engMember('sam'), 'POST', `/intents/${eng.id}/back-brief`, { words: 'ok', outcome: 'accepted' })).status).toBe(403);
    expect((await t.call(engLead, 'GET', '/me')).body.passed.map((x: { title: string }) => x.title)).toEqual(['Keep the ships at sea']);
    expect((await t.call(engLead, 'POST', `/intents/${eng.id}/back-brief`, { words: 'No radar on Corran', outcome: 'concern' })).body.error).toBe('incomplete');
    const concern = (await t.call(engLead, 'POST', `/intents/${eng.id}/back-brief`, { words: 'We keep both at sea', concern: 'No radar on Corran', outcome: 'concern' })).body;
    expect(concern.intent.life).toBe('passed');
    expect(t.notices.at(-1)).toMatchObject({ recipients: ['okafor'], needsYou: true });
    const accepted = (await t.call(engLead, 'POST', `/intents/${eng.id}/back-brief`, { words: 'We keep both at sea', outcome: 'accepted' })).body;
    expect(accepted.intent.life).toBe('active');
    expect(accepted.backBriefs.map((b: { outcome: string }) => b.outcome)).toEqual(['accepted', 'concern']);
    expect(accepted.lineOfSight.map((x: { title: string; purpose: string }) => [x.title, x.purpose])).toEqual([['Operation Alpha', 'p']]);
  });

  it('shows each person the line of sight above their part, and only summaries beside it', async () => {
    const { op, eng, sam } = await alpha(t.call);
    const log = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${LOG}`, title: 'Stock Port Ardel' })).body;
    // Sam reads every intent above his part.
    const mine = (await t.call(own('sam'), 'GET', `/intents/${sam.id}`)).body;
    expect(mine.lineOfSight.map((x: { title: string }) => x.title)).toEqual(['Operation Alpha', 'Keep Halcyon and Corran at sea']);
    expect((await t.call(own('sam'), 'GET', `/intents/${op.id}`)).status).toBe(200);
    // Priya, on Logistics, reads the operation (it's on the org's floor) and sees Engineering's part as a summary.
    const fromLog = (await t.call(orgMember('priya'), 'GET', `/intents/${op.id}`)).body;
    expect(fromLog.below.map((b: { title: string; sight: string; below: unknown[] }) => [b.title, b.sight, b.below.length])).toEqual([
      ['Keep Halcyon and Corran at sea', 'summary', 0],
      ['Stock Port Ardel', 'full', 0],
    ]);
    expect((await t.call(orgMember('priya'), 'GET', `/intents/${eng.id}`)).status).toBe(404);
    expect((await t.call(orgMember('priya'), 'GET', `/intents/${sam.id}`)).status).toBe(404);
    // The org's lead, standing on the org's floor, sees all the way down.
    const top = (await t.call(orgLead, 'GET', `/intents/${op.id}`)).body;
    expect(top.below[0].below.map((b: { title: string; sight: string }) => [b.title, b.sight])).toEqual([['Refit Halcyon’s port shaft', 'full']]);
    expect((await t.call(orgLead, 'GET', `/intents/${sam.id}`)).status).toBe(200);
    // Someone's own intents are theirs alone.
    const private_ = (await t.call(own('sam'), 'POST', '/intents', { title: 'Training' })).body;
    expect((await t.call(orgLead, 'GET', `/intents/${private_.id}`)).status).toBe(404);
    expect((await t.call(on('okafor', { id: 'w-sam', kind: 'personal', role: 'lead' }), 'GET', `/intents/${private_.id}`)).status).toBe(404);
    // Engineering's floor lists its own part, under the operation it's part of.
    const floor = (await t.call(engMember('sam'), 'GET', '/floor')).body;
    expect(floor.intents.map((x: { title: string; partOf: string; counts: { parts: number } }) => [x.title, x.partOf, x.counts.parts])).toEqual([['Keep Halcyon and Corran at sea', 'Operation Alpha', 1]]);
    // Find offers only what each person can read.
    const find = async (h: Record<string, string>) => (await t.call(h, 'GET', '/search?q=halcyon')).body.results.map((r: { title: string }) => r.title);
    expect(await find(own('sam'))).toEqual(['Refit Halcyon’s port shaft', 'Keep Halcyon and Corran at sea']);
    expect(await find(orgMember('priya'))).toEqual([]);
    void log;
  });

  it('puts a part’s back-brief in the Inbox of whoever holds it, and closes it once it’s said back or no longer needed', async () => {
    const { op, eng, sam } = await alpha(t.call);
    // Engineering's waited on its leads, Sam's on Sam; both said back, so both are done.
    expect(t.inbox.get(`back-brief/${eng.id}`)).toMatchObject({ workspace: ENG, state: 'done', item: { kind: 'back-brief', owner: { kind: 'team', id: ENG, role: 'lead' }, title: 'Keep Halcyon and Corran at sea', path: `/intents/${eng.id}`, from: 'okafor', allow: { decline: false, handOn: false } } });
    expect(t.inbox.get(`back-brief/${sam.id}`)).toMatchObject({ state: 'done', item: { owner: { kind: 'person', id: 'sam' }, subject: { kind: 'ref', app: 'mandate', type: 'intent', id: sam.id } } });
    // Revised above: Engineering's opens again, to say whether theirs still stands.
    await t.call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { endState: 'Three ships on station.' } });
    await t.call(orgLead, 'POST', `/intents/${op.id}/issue`);
    expect(t.inbox.get(`back-brief/${eng.id}`)).toMatchObject({ state: 'open', item: { reopen: true } });
    // A new part not yet said back is taken back when the operation is withdrawn.
    const log = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${LOG}`, title: 'Stock Port Ardel' })).body;
    expect(t.inbox.get(`back-brief/${log.id}`)?.state).toBe('open');
    await t.call(orgLead, 'POST', `/intents/${op.id}/withdraw`, { reason: 'Route closed for winter' });
    expect(t.inbox.get(`back-brief/${log.id}`)?.state).toBe('withdrawn');
    expect(t.inbox.get(`back-brief/${eng.id}`)?.state).toBe('withdrawn');
    expect(t.inbox.get(`back-brief/${sam.id}`)?.state).toBe('done');
  });

  it('asks the parts below to confirm their back-brief when the intent above is revised', async () => {
    const { op, eng } = await alpha(t.call);
    await t.call(orgLead, 'PATCH', `/intents/${op.id}`, { statement: { endState: 'Three ships on station.' } });
    await t.call(orgLead, 'POST', `/intents/${op.id}/issue`);
    expect(t.notices.at(-1)).toMatchObject({ recipients: ['dana', 'sam'], title: 'Operation Alpha has changed', needsYou: true });
    const seen = (await t.call(engLead, 'GET', `/intents/${eng.id}`)).body;
    expect(seen).toMatchObject({ recheck: true, can: { backBrief: true } });
    expect((await t.call(engLead, 'GET', '/me')).body.recheck.map((x: { title: string }) => x.title)).toEqual(['Keep Halcyon and Corran at sea']);
    const confirmed = (await t.call(engLead, 'POST', `/intents/${eng.id}/back-brief`, { words: 'Still stands: we can find a third.', outcome: 'accepted' })).body;
    expect(confirmed).toMatchObject({ recheck: false, intent: { life: 'active' } });
  });

  it('takes the holder’s judgement, tells the giver when it isn’t on track, and asks again after its rhythm', async () => {
    const { eng, sam } = await alpha(t.call);
    // Freshly accepted, it isn't due yet; a week on with no word, it is.
    expect((await t.call(engMember('sam'), 'GET', `/intents/${sam.id}`)).body.assessmentDue).toBe(false);
    t.later(8);
    expect((await t.call(engMember('sam'), 'GET', `/intents/${sam.id}`)).body.assessmentDue).toBe(true);
    await t.call(engMember('sam'), 'POST', `/intents/${sam.id}/assess`, { rating: 'at_risk', note: 'Bearings late' });
    expect(t.notices.at(-1)).toMatchObject({ recipients: ['dana'], title: '“Refit Halcyon’s port shaft” is at risk', detail: 'Bearings late' });
    expect((await t.call(engMember('sam'), 'GET', '/me')).body.due).toEqual([]);
    // Sam's judgement shows on Engineering's part, for everyone who sees it.
    const above = (await t.call(engLead, 'GET', `/intents/${eng.id}`)).body;
    expect(above.below[0]).toMatchObject({ rating: 'at_risk', ratingNote: 'Bearings late' });
    expect((await t.call(engLead, 'POST', `/intents/${sam.id}/assess`, { rating: 'on_track' })).status).toBe(403);
    t.later(8);
    expect((await t.call(engMember('sam'), 'GET', '/me')).body.due.map((x: { title: string }) => x.title)).toEqual(['Refit Halcyon’s port shaft']);
    expect((await t.call(engMember('sam'), 'GET', '/home')).body).toMatchObject({ due: 1, holding: 1 });
  });

  it('closes a part as achieved by whoever passed it down, and withdraws whole branches', async () => {
    const { op, eng, sam } = await alpha(t.call);
    await t.call(engMember('sam'), 'POST', `/intents/${sam.id}/assess`, { rating: 'achieved' });
    expect((await t.call(engMember('sam'), 'POST', `/intents/${sam.id}/achieve`)).status).toBe(403);
    expect((await t.call(engLead, 'POST', `/intents/${sam.id}/achieve`)).body.intent.life).toBe('achieved');
    const other = (await t.call(engLead, 'POST', `/intents/${eng.id}/pass`, { to: 'person:dana', title: 'Plan the yard slots' })).body;
    const withdrawn = (await t.call(orgLead, 'POST', `/intents/${eng.id}/withdraw`, { reason: 'Corran is sold' })).body;
    expect(withdrawn.intent.life).toBe('withdrawn');
    expect((await t.store.intent(other.id))!.life).toBe('withdrawn');
    expect((await t.store.intent(sam.id))!.life).toBe('achieved');
    expect((await t.call(orgLead, 'GET', `/intents/${op.id}`)).body.below[0].life).toBe('withdrawn');
    expect((await t.call(engLead, 'GET', '/floor')).body.closed.map((x: { title: string }) => x.title)).toEqual(['Keep Halcyon and Corran at sea']);
  });

  it('binds an entity sent without a label, as the shared reference allows', async () => {
    const { op } = await alpha(t.call);
    const bound = (await t.call(orgLead, 'POST', `/intents/${op.id}/entities`, { entity: { kind: 'entity', id: 'ent_yard', type: 'port' }, role: 'related' })).body;
    expect(bound.entities).toContainEqual(expect.objectContaining({ entity: { kind: 'entity', id: 'ent_yard', type: 'port', label: '' }, role: 'related' }));
  });

  it('marks one main effort among the parts', async () => {
    const { op, eng } = await alpha(t.call);
    const log = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${LOG}`, title: 'Stock Port Ardel' })).body;
    await t.call(orgLead, 'POST', `/intents/${eng.id}/main-effort`, { on: true });
    await t.call(orgLead, 'POST', `/intents/${log.id}/main-effort`, { on: true });
    const below = (await t.call(orgLead, 'GET', `/intents/${op.id}`)).body.below;
    expect(below.map((b: { mainEffort: boolean }) => b.mainEffort)).toEqual([false, true]);
    expect((await t.call(engLead, 'POST', `/intents/${eng.id}/main-effort`, { on: true })).status).toBe(403);
  });

  it('asks whoever passed a part down to pass it again when its holder leaves, and gives it back if they return', async () => {
    const { sam } = await alpha(t.call);
    await t.follow({ topic: PLATFORM_TOPICS.personDisabled, payload: { person: 'sam' } });
    // Twice does no harm: the reason and date stay the first.
    await t.follow({ topic: PLATFORM_TOPICS.personDisabled, payload: { person: 'sam' } });
    const part = (await t.call(engLead, 'GET', `/intents/${sam.id}`)).body;
    expect(part.intent).toMatchObject({ holder: 'person:sam', holderName: 'Sam Patel', needsHolder: { why: 'disabled' } });
    expect(part.can.passAgain).toBe(true);
    expect(t.inbox.get(`needs-holder/${sam.id}`)).toMatchObject({ state: 'open', item: { kind: 'needs-holder', owner: { kind: 'person', id: 'dana' } } });
    expect(t.notices.filter((n) => n.title.includes('needs a holder'))).toHaveLength(1);
    expect((await t.outbox()).filter((e) => e.topic === TOPICS.needsHolder)).toHaveLength(1);
    // Signed back in before anyone else took it on: it's theirs again.
    await t.follow({ topic: PLATFORM_TOPICS.personEnabled, payload: { person: 'sam' } });
    expect((await t.call(engLead, 'GET', `/intents/${sam.id}`)).body.intent.needsHolder).toBeUndefined();
    expect(t.inbox.get(`needs-holder/${sam.id}`)?.state).toBe('withdrawn');
  });

  it('passes a part again to someone new, who says it back before it’s under way', async () => {
    const { sam } = await alpha(t.call);
    expect((await t.call(engLead, 'POST', `/intents/${sam.id}/pass-again`, { to: 'person:dana' })).body.error).toBe('not-now');
    await t.follow({ topic: PLATFORM_TOPICS.personLeft, payload: { person: 'sam', handOverTo: 'dana' } });
    expect(t.inbox.get(`needs-holder/${sam.id}`)?.item.detail).toContain('They handed their work over to Dana Ross.');
    // Only whoever passed it down, or a lead of the floor above.
    expect((await t.call(engMember('sam'), 'POST', `/intents/${sam.id}/pass-again`, { to: 'person:dana' })).status).toBe(403);
    expect((await t.call(engLead, 'POST', `/intents/${sam.id}/pass-again`, { to: 'person:priya' })).body.error).toBe('bad-target');
    const again = (await t.call(engLead, 'POST', `/intents/${sam.id}/pass-again`, { to: 'person:dana' })).body;
    expect(again.intent).toMatchObject({ holder: 'person:dana', life: 'passed' });
    expect(again.intent.needsHolder).toBeUndefined();
    expect(t.inbox.get(`needs-holder/${sam.id}`)?.state).toBe('done');
    expect(t.inbox.get(`back-brief/${sam.id}`)).toMatchObject({ state: 'open', item: { owner: { kind: 'person', id: 'dana' } } });
    expect(again.statement.purpose).toBe('');
  });

  it('marks only the parts on a team’s floor when someone leaves that team, and follows the team’s new name', async () => {
    const { eng, sam } = await alpha(t.call);
    const board = (await t.call(orgLead, 'POST', `/intents/${(await alpha(t.call)).op.id}/pass`, { to: 'person:sam', title: 'Brief the board' })).body;
    await t.follow({ topic: PLATFORM_TOPICS.memberRemoved, payload: { team: ENG, person: 'sam' } });
    expect((await t.call(engLead, 'GET', `/intents/${sam.id}`)).body.intent.needsHolder).toMatchObject({ why: 'removed' });
    expect((await t.call(orgLead, 'GET', `/intents/${board.id}`)).body.intent.needsHolder).toBeUndefined();
    await t.follow({ topic: PLATFORM_TOPICS.teamRenamed, payload: { team: ENG, name: 'Marine Engineering' } });
    expect((await t.call(engLead, 'GET', `/intents/${eng.id}`)).body.intent).toMatchObject({ floorName: 'Marine Engineering', holderName: 'Marine Engineering' });
  });

  it('shows entities Data Atlas retired, and moves bindings to the survivor of a merge and back when it’s split', async () => {
    const { eng, sam } = await alpha(t.call);
    const ship = (id: string, label: string) => ({ kind: 'entity', id, type: 'vessel', label });
    await t.call(engLead, 'POST', `/intents/${eng.id}/entities`, { entity: ship('ent_old', 'MV Halcyon'), role: 'subject' });
    await t.call(engLead, 'POST', `/intents/${eng.id}/entities`, { entity: ship('ent_new', 'Halcyon'), role: 'subject' });
    await t.call(engMember('sam'), 'POST', `/intents/${sam.id}/entities`, { entity: ship('ent_old', 'MV Halcyon'), role: 'subject' });
    await t.follow({ topic: ATLAS_TOPICS.retired, payload: { entity: 'ent_new', type: 'vessel' } });
    expect((await t.call(engLead, 'GET', `/intents/${eng.id}`)).body.entities.find((e: { entity: { id: string } }) => e.entity.id === 'ent_new').state).toBe('retired');

    const before = (await t.outbox()).length;
    await t.follow({ topic: ATLAS_TOPICS.merged, payload: { entity: 'ent_old', into: 'ent_new', merge: 'm1', type: 'vessel' } });
    await t.follow({ topic: ATLAS_TOPICS.merged, payload: { entity: 'ent_old', into: 'ent_new', merge: 'm1', type: 'vessel' } });
    // Sam's part now points at the survivor; Engineering's was bound to it already, so it shows once.
    expect((await t.call(engMember('sam'), 'GET', `/intents/${sam.id}`)).body.entities).toMatchObject([{ entity: { id: 'ent_new', label: 'MV Halcyon' }, mergedFrom: 'ent_old' }]);
    expect((await t.call(engLead, 'GET', `/intents/${eng.id}`)).body.entities.map((e: { entity: { id: string } }) => e.entity.id)).toEqual(['ent_new']);
    expect((await t.outbox()).slice(before).map((e) => `${e.topic} ${e.payload.intent} ${e.payload.entity}`).sort()).toEqual(
      [`${TOPICS.entityUnbound} ${eng.id} ent_old`, `${TOPICS.entityBound} ${sam.id} ent_new`, `${TOPICS.entityUnbound} ${sam.id} ent_old`].sort(),
    );

    await t.follow({ topic: ATLAS_TOPICS.split, payload: { entity: 'ent_old', from: 'ent_new', merge: 'm1', type: 'vessel' } });
    expect((await t.call(engMember('sam'), 'GET', `/intents/${sam.id}`)).body.entities).toMatchObject([{ entity: { id: 'ent_old' } }]);
    expect((await t.call(engLead, 'GET', `/intents/${eng.id}`)).body.entities.map((e: { entity: { id: string } }) => e.entity.id).sort()).toEqual(['ent_new', 'ent_old']);
  });

  it('keeps a part’s discussion: the holder’s concern, the giver’s answer, and nobody else’s word', async () => {
    const { op, eng } = await alpha(t.call);
    const jo = (await t.call(engLead, 'POST', `/intents/${eng.id}/pass`, { to: `team:${HULL}`, title: 'Survey Corran’s hull' })).body;
    const ref = (id: string) => ({ kind: 'ref', app: 'mandate', type: 'intent', id });
    const hull = on('jo', { id: HULL, kind: 'team', role: 'lead' });
    await t.call(hull, 'POST', `/intents/${jo.id}/back-brief`, { words: 'Survey the hull by Friday.', concern: 'No dry dock is free this week.', outcome: 'concern' });
    let thread = (await t.call(engLead, 'GET', `/threads?app=mandate&type=intent&id=${jo.id}`)).body;
    expect(thread.messages).toMatchObject([{ kind: 'concern', words: 'No dry dock is free this week.', byName: 'Jo Lee' }]);
    expect(thread.waiting).toMatchObject({ concern: thread.messages[0].id, on: 'Dana Ross' });
    expect(thread.can.kinds.sort()).toEqual(['answer', 'note']);
    expect(t.notices.at(-1)).toMatchObject({ recipients: ['dana'], needsYou: true });

    expect((await t.call(engLead, 'POST', '/threads/messages', { ref: ref(jo.id), kind: 'answer', words: 'Use the floating dock at Ardel.' })).status).toBe(201);
    thread = (await t.call(hull, 'GET', `/threads?app=mandate&type=intent&id=${jo.id}`)).body;
    expect(thread.messages.map((m: { kind: string }) => m.kind)).toEqual(['concern', 'answer']);
    expect(thread.messages[1].answers).toBe(thread.messages[0].id);
    expect(thread.waiting).toBeUndefined();
    expect(thread.can.kinds.sort()).toEqual(['concern', 'note']);
    expect(t.notices.at(-1)).toMatchObject({ title: expect.stringContaining('answered'), link: `/intents/${jo.id}#discussion` });
    // Nothing waits for an answer now, and the holder doesn't answer their own.
    expect((await t.call(engLead, 'POST', '/threads/messages', { ref: ref(jo.id), kind: 'answer', words: 'Again' })).body.message).toBe('There’s no concern waiting for an answer.');

    // The org's lead reads it in full, but only the two sides write.
    const read = (await t.call(orgLead, 'GET', `/threads?app=mandate&type=intent&id=${jo.id}`)).body;
    expect(read.can).toMatchObject({ write: false, why: expect.stringContaining('whoever passed it down') });
    expect((await t.call(orgLead, 'POST', '/threads/messages', { ref: ref(jo.id), kind: 'note', words: 'Hello' })).status).toBe(403);
    // Someone who sees the part only as a summary reads no discussion.
    const sam = (await t.call(engLead, 'POST', `/intents/${eng.id}/pass`, { to: 'person:sam', title: 'Order bearings' })).body;
    expect((await t.call(engMember('sam'), 'GET', `/threads?app=mandate&type=intent&id=${jo.id}`)).status).toBe(404);
    expect((await t.call(engMember('sam'), 'GET', `/threads?app=folio&type=document&id=${sam.id}`)).body.message).toBe('Only intents have discussions for now.');
    expect((await t.outbox()).filter((e) => e.topic === TOPICS.discussed).map((e) => e.payload.kind)).toEqual(['concern', 'answer']);

    // Closed, so its discussion is too; what was said stays.
    await t.call(orgLead, 'POST', `/intents/${op.id}/withdraw`, { reason: 'Route closed' });
    const closed = (await t.call(engLead, 'GET', `/threads?app=mandate&type=intent&id=${jo.id}`)).body;
    expect(closed).toMatchObject({ messages: [{}, {}], can: { write: false, why: 'It’s closed, so its discussion is too.' } });
    expect((await t.call(hull, 'POST', '/threads/messages', { ref: ref(jo.id), kind: 'note', words: 'Late' })).status).toBe(409);
  });

  it('lets whoever passed a part down change it while it waits, as the next version, answering the concern', async () => {
    const { eng, sam } = await alpha(t.call);
    expect((await t.call(engLead, 'PATCH', `/intents/${sam.id}/passed`, { title: 'X' })).body.message).toContain('It’s been accepted');
    const part = (await t.call(engLead, 'POST', `/intents/${eng.id}/pass`, { to: 'person:sam', title: 'Order bearings', purpose: 'The refit needs them.' })).body;
    await t.call(engMember('sam'), 'POST', `/intents/${part.id}/back-brief`, { words: 'Order bearings.', concern: 'Which supplier?', outcome: 'concern' });
    expect((await t.call(engMember('sam'), 'PATCH', `/intents/${part.id}/passed`, { title: 'Mine now' })).status).toBe(403);
    const changed = (await t.call(engLead, 'PATCH', `/intents/${part.id}/passed`, { title: 'Order bearings from Halden', purpose: 'The refit needs them by the 14th.' })).body;
    expect(changed.intent).toMatchObject({ title: 'Order bearings from Halden', life: 'passed', version: 2 });
    expect(changed.statement.purpose).toBe('The refit needs them by the 14th.');
    expect(changed.versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    const thread = (await t.call(engMember('sam'), 'GET', `/threads?app=mandate&type=intent&id=${part.id}`)).body;
    expect(thread.messages.at(-1)).toMatchObject({ kind: 'answer', words: expect.stringContaining('Changed what was passed') });
    expect(thread.waiting).toBeUndefined();
    expect(t.inbox.get(`back-brief/${part.id}`)).toMatchObject({ state: 'open', item: { owner: { kind: 'person', id: 'sam' } } });
    expect((await t.call(engMember('sam'), 'POST', `/intents/${part.id}/back-brief`, { words: 'Order from Halden by the 14th.', outcome: 'accepted' })).body.intent.life).toBe('active');
  });

  it('lets the open parts stand alone when the intent above closes, keeping what they carry and saying where from', async () => {
    const { op, eng, sam } = await alpha(t.call);
    const ship = { kind: 'entity', id: 'ent_ship', type: 'vessel', label: 'Halcyon' };
    await t.call(orgLead, 'POST', `/intents/${op.id}/entities`, { entity: ship, role: 'subject' });
    const log = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${LOG}`, title: 'Fuel Ardel', carry: { entities: ['ent_ship|subject'] } })).body;
    const closed = (await t.call(orgLead, 'POST', `/intents/${op.id}/withdraw`, { reason: 'The route moved', parts: 'stand-alone' })).body;
    expect(closed.intent.life).toBe('withdrawn');
    expect(closed.below).toEqual([]);
    // Engineering's part now heads its own tree, with Sam's part still below it.
    const own = (await t.call(engLead, 'GET', `/intents/${eng.id}`)).body;
    expect(own.intent).toMatchObject({ life: 'active', root: eng.id });
    expect(own.intent.parent).toBeUndefined();
    expect(own.lineOfSight).toEqual([]);
    expect(own.stoodAlone).toMatchObject({ from: 'Operation Alpha' });
    expect(own.below.map((b: { id: string }) => b.id)).toEqual([sam.id]);
    expect((await t.call(engMember('sam'), 'GET', `/intents/${sam.id}`)).body.lineOfSight.map((a: { id: string }) => a.id)).toEqual([eng.id]);
    expect((await t.call(engLead, 'GET', '/floor')).body.intents.map((i: { id: string }) => i.id)).toContain(eng.id);
    // What Logistics' part carried down stays, named as no longer above it.
    const fuel = (await t.call(on('priya', { id: LOG, kind: 'team', role: 'lead' }), 'GET', `/intents/${log.id}`)).body;
    expect(fuel.entities).toMatchObject([{ entity: { id: 'ent_ship' }, from: 'Operation Alpha (no longer above)' }]);
    expect((await t.outbox()).filter((e) => e.topic === TOPICS.stoodAlone).map((e) => e.payload.intent).sort()).toEqual([eng.id, log.id].sort());
    expect(t.notices.filter((n) => n.detail?.includes('stands on its own'))).not.toHaveLength(0);
  });

  it('passes a part again to a team below, moving it to that team’s floor', async () => {
    const { sam } = await alpha(t.call);
    await t.follow({ topic: PLATFORM_TOPICS.personLeft, payload: { person: 'sam' } });
    expect((await t.call(engLead, 'POST', `/intents/${sam.id}/pass-again`, { to: `team:${HULL}` })).body.intent).toMatchObject({ holder: 'floor', floorName: 'Hull', life: 'passed' });
    const hull = on('jo', { id: HULL, kind: 'team', role: 'lead' });
    expect((await t.call(hull, 'GET', '/floor')).body.intents.map((i: { id: string }) => i.id)).toContain(sam.id);
    expect((await t.call(hull, 'GET', `/intents/${sam.id}`)).body.can.backBrief).toBe(true);
  });

  it('binds entities and documents, carries the chosen ones down, and gives other tools the context', async () => {
    const { op } = await alpha(t.call);
    const halcyon = { kind: 'entity', id: 'ent_halcyon', type: 'vessel', label: 'MV Halcyon' };
    await t.call(orgLead, 'POST', `/intents/${op.id}/entities`, { entity: halcyon, role: 'subject' });
    await t.call(orgLead, 'POST', `/intents/${op.id}/entities`, { entity: { kind: 'entity', id: 'ent_route', type: 'route', label: 'Northern route' }, role: 'area' });
    const doc = (await t.call(orgLead, 'POST', `/intents/${op.id}/documents`, { document: { app: 'folio', id: 'd7', title: 'Winter route order', version: '3' } })).body;
    expect(doc.documents).toEqual([expect.objectContaining({ document: { app: 'folio', id: 'd7', title: 'Winter route order', version: '3' } })]);
    expect((await t.call(orgMember('priya'), 'POST', `/intents/${op.id}/entities`, { entity: halcyon, role: 'subject' })).status).toBe(403);
    const log = (await t.call(orgLead, 'POST', `/intents/${op.id}/pass`, { to: `team:${LOG}`, title: 'Stock Port Ardel', carry: { entities: ['ent_route|area'], documents: ['folio|d7'] } })).body;
    const part = (await t.call(orgMember('priya'), 'GET', `/intents/${log.id}`)).body;
    expect(part.entities).toEqual([expect.objectContaining({ entity: expect.objectContaining({ id: 'ent_route' }), role: 'area', from: 'Operation Alpha' })]);
    expect(part.documents).toEqual([expect.objectContaining({ from: 'Operation Alpha' })]);
    expect((await t.outbox()).filter((e) => e.topic === TOPICS.entityBound).map((e) => e.payload)).toEqual([
      { intent: op.id, entity: 'ent_halcyon', role: 'subject' },
      { intent: op.id, entity: 'ent_route', role: 'area' },
      { intent: log.id, entity: 'ent_route', role: 'area' },
    ]);
    // The context for a tool working under the operation, one level down, as Priya sees it.
    const context = (await t.call(orgMember('priya'), 'GET', `/intents/${op.id}/context?depth=1`)).body;
    expect(context.intent).toEqual({ kind: 'intent', app: 'mandate', id: op.id, title: 'Operation Alpha' });
    expect(context.entities.map((e: { ref: { id: string }; from: { title: string } }) => [e.ref.id, e.from.title])).toEqual([
      ['ent_halcyon', 'Operation Alpha'],
      ['ent_route', 'Operation Alpha'],
      ['ent_route', 'Stock Port Ardel'],
    ]);
    expect(context.children.map((c: { intent: { title: string } }) => c.intent.title)).toEqual(['Keep Halcyon and Corran at sea', 'Stock Port Ardel']);
    // What uses the route, and names for another app's "used by".
    expect((await t.call(orgMember('priya'), 'GET', '/entities/ent_route/intents')).body.intents.map((i: { title: string }) => i.title)).toEqual(['Operation Alpha', 'Stock Port Ardel']);
    const unbound = (await t.call(orgLead, 'DELETE', `/intents/${op.id}/entities/ent_halcyon?role=subject`)).body;
    expect(unbound.entities.map((e: { entity: { id: string } }) => e.entity.id)).toEqual(['ent_route']);
    const names = (await t.call(own('jo'), 'POST', '/refs/resolve', { ids: [op.id, log.id, 'nope'] })).body;
    expect(names.refs).toEqual([{ id: op.id, label: 'Operation Alpha', canOpen: true }, { id: log.id, label: 'Stock Port Ardel', canOpen: false }, { id: 'nope', canOpen: false }]);
  });
};

describe('mandate', () =>
  behaves(async () => {
    const store = new MemoryMandateStore();
    return { store, outbox: async () => store.outbox };
  }));

// Runs wherever DATABASE_URL points at a Postgres; CI starts one for it.
describe.runIf(process.env.DATABASE_URL)('mandate on Postgres', () => {
  let admin: pg.Pool;
  let store: PgMandateStore;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query('drop schema if exists mandate cascade');
    store = await PgMandateStore.connect(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await store.close();
    await admin.end();
  });
  behaves(async () => {
    await admin.query('truncate mandate.messages, mandate.event_cursor, mandate.outbox, mandate.entity_bindings, mandate.document_bindings, mandate.assessments, mandate.back_briefs, mandate.versions, mandate.intents');
    return {
      store,
      outbox: async () => (await admin.query('select topic, workspace_id as workspace, payload from mandate.outbox order by id')).rows,
    };
  });
});
