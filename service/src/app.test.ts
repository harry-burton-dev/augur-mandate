import { callerCheckFor, callerHeaders, callerSigner, signedCallerHeaders, type CallerWorkspace } from '@augur/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
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
  let clock = Date.parse('2026-10-27T09:00:00Z');
  const app = await buildApp({ store, people, notify: async (n) => void notices.push(n), audit: async () => {}, now: () => new Date((clock += 1000)) });
  const call = async (headers: Record<string, string>, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const later = (days: number) => (clock += days * 24 * 60 * 60 * 1000);
  return { app, store, notices, call, later, outbox };
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
    await admin.query('truncate mandate.outbox, mandate.entity_bindings, mandate.document_bindings, mandate.assessments, mandate.back_briefs, mandate.versions, mandate.intents');
    return {
      store,
      outbox: async () => (await admin.query('select topic, workspace_id as workspace, payload from mandate.outbox order by id')).rows,
    };
  });
});
