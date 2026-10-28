import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { callerCheckFromEnv, callerFromHeaders, health, packageVersion, PeopleUnavailable, signedCallers, type CallerCheck, type CallerWorkspace } from '@augur/service-kit';
import { auditFromEnv, type Audit } from './audit.ts';
import { notifyFromEnv, type Notify } from './notices.ts';
import { floorPrincipal, peopleFromEnv, type People } from './people.ts';
import { assessmentDue, ended, maySet, needsRecheck, rightsOn, sightOf, type Rights, type Sight, type Viewer } from './rules.ts';
import {
  ConflictError,
  EMPTY_STATEMENT,
  MemoryMandateStore,
  newId,
  RATINGS,
  TOPICS,
  type Change,
  type DocumentBinding,
  type DocumentRef,
  type EntityBinding,
  type EntityRef,
  type Intent,
  type MandateStore,
  type OutboxEvent,
  type Rating,
  type Statement,
} from './store.ts';

/** The major version of the API this service serves. Its routes go under /v1, as the platform's do. */
export const API_VERSION = 'v1';
const version = packageVersion(import.meta.url);

/** How deep intents may nest: deeper than any team tree (five), with room for people's parts and phases. */
export const MAX_DEPTH = 8;

export interface Options {
  /** Checks the caller the gateway signed for Mandate. In production it is on by default; in dev `x-user-*` headers are believed. */
  callers?: CallerCheck;
  store?: MandateStore;
  audit?: Audit;
  notify?: Notify;
  people?: People;
  now?: () => Date;
}

/** An intent as its summary shows it: in a tree, a list, or beside your own part. */
export interface Summary {
  id: string;
  parent?: string;
  root: string;
  title: string;
  floorName: string;
  floorKind: Intent['floorKind'];
  holder: string;
  holderName: string;
  life: Intent['life'];
  version: number;
  mainEffort: boolean;
  byDate?: string;
  rating?: Rating;
  ratingNote?: string;
  ratedAt?: string;
  sight: Sight;
}

/** A summary with what's below it, as far as the viewer sees. */
export type Branch = Summary & { below: Branch[] };

const summaryOf = (i: Intent, sight: Sight): Summary => ({
  id: i.id,
  ...(i.parent ? { parent: i.parent } : {}),
  root: i.root,
  title: i.title,
  floorName: i.floorName,
  floorKind: i.floorKind,
  holder: i.holder,
  holderName: i.holderName,
  life: i.life,
  version: i.version,
  mainEffort: i.mainEffort,
  ...(i.byDate ? { byDate: i.byDate } : {}),
  ...(sight === 'full' && i.rating ? { rating: i.rating, ...(i.ratingNote ? { ratingNote: i.ratingNote } : {}), ...(i.ratedAt ? { ratedAt: i.ratedAt } : {}) } : {}),
  ...(sight === 'summary' && i.rating ? { rating: i.rating } : {}),
  sight,
});

const TEXT = (max: number) => ({ type: 'string', maxLength: max }) as const;
const TITLE = { type: 'string', minLength: 1, maxLength: 140, pattern: '\\S' } as const;
const ID_PARAMS = { type: 'object', properties: { id: TEXT(64) }, required: ['id'] } as const;
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const STATEMENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mission: TEXT(500),
    purpose: TEXT(2000),
    endState: TEXT(2000),
    keyTasks: { type: 'array', maxItems: 12, items: TEXT(300) },
    constraints: TEXT(2000),
    restraints: TEXT(2000),
    freedoms: TEXT(2000),
  },
} as const;
const ENTITY_REF = {
  type: 'object',
  required: ['kind', 'id', 'type'],
  properties: { kind: { const: 'entity' }, id: TEXT(200), type: TEXT(80), label: TEXT(300), at: TEXT(40) },
} as const;
const DOCUMENT_REF = {
  type: 'object',
  required: ['app', 'id', 'title'],
  properties: { app: TEXT(40), id: TEXT(200), title: TEXT(300), version: TEXT(40) },
} as const;

/** Trims every part of a statement, and drops empty key tasks. */
const tidy = (s: Partial<Statement>, was: Statement): Statement => ({
  mission: (s.mission ?? was.mission).trim(),
  purpose: (s.purpose ?? was.purpose).trim(),
  endState: (s.endState ?? was.endState).trim(),
  keyTasks: (s.keyTasks ?? was.keyTasks).map((t) => t.trim()).filter(Boolean),
  constraints: (s.constraints ?? was.constraints).trim(),
  restraints: (s.restraints ?? was.restraints).trim(),
  freedoms: (s.freedoms ?? was.freedoms).trim(),
});

const lifeWords: Record<Intent['life'], string> = { draft: 'Draft', passed: 'Waiting for a back-brief', active: '', achieved: 'Achieved', superseded: 'Closed', withdrawn: 'Withdrawn' };

const personOf = (holder: string) => (holder.startsWith('person:') ? holder.slice('person:'.length) : undefined);

export const buildApp = async ({ callers = callerCheckFromEnv('mandate'), store = new MemoryMandateStore(), audit, notify, people = peopleFromEnv(), now = () => new Date() }: Options = {}) => {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const record = audit ?? auditFromEnv((entry) => app.log.info({ audit: entry }, 'audit (no audit log here)'));
  const tell = notify ?? notifyFromEnv((notice) => app.log.info({ notice }, 'notification (no notifications here)'));
  const recorded = (entry: Parameters<Audit>[0]) =>
    record(entry).catch((err: Error) => app.log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));
  const told = (notice: Parameters<Notify>[0]) =>
    notice.recipients.length ? tell(notice).catch((err: Error) => app.log.error({ err: err.message, title: notice.title }, 'could not tell people')) : Promise.resolve();

  // Only the gateway's signed word says who is calling: headers anyone could send are dropped.
  app.addHook('onRequest', signedCallers(callers));
  app.get('/healthz', async () => health('mandate', version, API_VERSION));

  /** Who is calling, on which floor, and who they stand for; or a refusal already sent. Every intent lives on a floor. */
  const viewerOf = async (req: FastifyRequest, reply: FastifyReply): Promise<Viewer | undefined> => {
    const caller = callerFromHeaders(req.headers);
    if (!caller) {
      reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to use Mandate.' });
      return undefined;
    }
    if (!caller.workspace) {
      reply.code(400).send({ error: 'floor-needed', message: 'Say which floor you’re on (X-Workspace-Id).' });
      return undefined;
    }
    const workspace = caller.workspace as CallerWorkspace;
    return { id: caller.id, name: caller.name, workspace, principals: await people.principals(caller.id, workspace) };
  };

  /** An intent with its whole tree, and how far the viewer sees into it. One they can't see is as good as not there. */
  const load = async (v: Viewer, id: string, reply: FastifyReply) => {
    const found = await store.intent(id);
    const tree = found ? await store.tree(found.root) : [];
    const sight = sightOf(v, tree);
    const intent = tree.find((i) => i.id === id);
    if (!intent || sight.get(id) !== 'full') {
      reply.code(404).send({ error: 'not-found', message: 'There’s no such intent, or it isn’t one you can read.' });
      return undefined;
    }
    const byId = new Map(tree.map((i) => [i.id, i]));
    const parent = intent.parent ? byId.get(intent.parent) : undefined;
    return { intent, tree, sight, byId, parent, can: rightsOn(v, intent, parent) };
  };
  type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

  const refuse = (reply: FastifyReply, message: string) => reply.code(403).send({ error: 'forbidden', message });
  const unfit = (reply: FastifyReply, message: string) => reply.code(409).send({ error: 'not-now', message });

  /** The branches below an intent, as far as the viewer sees. */
  const branchesBelow = (id: string, tree: readonly Intent[], sight: Map<string, Sight>): Branch[] =>
    tree.filter((i) => i.parent === id && sight.has(i.id)).map((i) => ({ ...summaryOf(i, sight.get(i.id)!), below: branchesBelow(i.id, tree, sight) }));

  /** Who to tell about an intent: the person holding it, or everyone on the team that does. */
  const holdersOf = async (i: Intent) => {
    const person = personOf(i.holder);
    if (person) return [person];
    if (i.floorKind === 'team') return people.audience([`team:${i.workspace}`]).catch(() => []);
    return [];
  };
  /** Who passed it down, to hear back-briefs, concerns and claims. */
  const giverOf = (i: Intent, parent?: Intent) => (i.passedBy ? [i.passedBy] : parent ? [personOf(parent.holder)].filter((p): p is string => Boolean(p)) : []);

  const stamp = () => now().toISOString();
  const event = (topic: string, i: Intent, payload: Record<string, unknown> = {}): OutboxEvent => ({ topic, workspace: i.workspace, payload: { intent: i.id, ...payload } });

  /** Writes a change, or says someone else changed it first. */
  const commit = async (change: Change, reply: FastifyReply) => {
    try {
      await store.commit(change);
      return true;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      reply.code(409).send({ error: 'changed', message: 'Someone else changed this intent just now. Reload it and try again.' });
      return false;
    }
  };

  /** Everything the intent page shows. */
  const detailOf = async (v: Viewer, { intent, tree, sight, byId, parent, can }: Loaded) => {
    const chain = intent.ancestors.map((a) => byId.get(a)).filter((a): a is Intent => Boolean(a));
    const [versions, backBriefs, assessments, entities, documents] = await Promise.all([
      store.versions(intent.id),
      store.backBriefs(intent.id),
      store.assessments(intent.id, 10),
      store.entityBindings([intent.id]),
      store.documentBindings([intent.id]),
    ]);
    const issued = versions[0];
    const chainVersions = await Promise.all(chain.map((a) => store.versions(a.id).then((vs) => vs[0])));
    return {
      intent: summaryOf(intent, 'full'),
      statement: issued?.statement ?? intent.draft,
      ...(can.edit ? { draft: intent.draft } : {}),
      issued: issued ? { version: issued.version, by: issued.issuedByName, at: issued.issuedAt } : undefined,
      versions: versions.map((x) => ({ version: x.version, title: x.title, by: x.issuedByName, at: x.issuedAt })),
      passed: intent.passedBy ? { by: intent.passedByName, at: intent.passedAt } : undefined,
      rhythmDays: intent.rhythmDays,
      ended: intent.endedAt ? { at: intent.endedAt, reason: intent.endedReason ?? '' } : undefined,
      lineOfSight: chain.map((a, n) => ({
        ...summaryOf(a, 'full'),
        mission: chainVersions[n]?.statement.mission ?? '',
        purpose: chainVersions[n]?.statement.purpose ?? '',
        endState: chainVersions[n]?.statement.endState ?? '',
      })),
      below: branchesBelow(intent.id, tree, sight),
      backBriefs,
      assessments,
      entities: entities.map(({ entity, role, inheritedFrom, at }) => ({ entity, role, ...(inheritedFrom ? { from: byId.get(inheritedFrom)?.title ?? '' } : {}), at })),
      documents: documents.map(({ document, inheritedFrom, at }) => ({ document, ...(inheritedFrom ? { from: byId.get(inheritedFrom)?.title ?? '' } : {}), at })),
      recheck: needsRecheck(intent, parent),
      assessmentDue: holdsNow(v, intent) && assessmentDue(intent, now().getTime()),
      can,
    };
  };
  const holdsNow = (v: Viewer, i: Intent) => rightsOn(v, i, undefined).assess;

  /** The trees an intent list touches, and how far the viewer sees into each. */
  const sightsFor = async (v: Viewer, intents: readonly Intent[]) => {
    const roots = [...new Set(intents.map((i) => i.root))];
    const trees = await Promise.all(roots.map((r) => store.tree(r)));
    const sight = new Map<string, Sight>();
    const byId = new Map<string, Intent>();
    for (const tree of trees) {
      for (const [id, s] of sightOf(v, tree)) sight.set(id, s);
      for (const i of tree) byId.set(i.id, i);
    }
    return { sight, byId };
  };

  /** What the viewer holds or is waiting to accept, on any floor. */
  const yours = async (v: Viewer) => {
    const own = await store.heldBy(v.id);
    const floor = (await store.onFloor(v.workspace.id)).filter((i) => i.holder === 'floor');
    const held = [...own, ...floor.filter((i) => !own.some((o) => o.id === i.id))];
    const { byId } = await sightsFor(v, held);
    const mine = held.filter((i) => rightsOn(v, i, i.parent ? byId.get(i.parent) : undefined).backBrief || rightsOn(v, i, undefined).assess);
    const passed = mine.filter((i) => i.life === 'passed');
    const recheck = mine.filter((i) => needsRecheck(i, i.parent ? byId.get(i.parent) : undefined));
    const due = mine.filter((i) => assessmentDue(i, now().getTime()));
    const holding = mine.filter((i) => i.life === 'active');
    const parentTitle = (i: Intent) => (i.parent ? byId.get(i.parent)?.title : undefined);
    const item = (i: Intent) => ({ ...summaryOf(i, 'full'), ...(parentTitle(i) ? { partOf: parentTitle(i) } : {}) });
    return { passed: passed.map(item), recheck: recheck.map(item), due: due.map(item), holding: holding.map(item) };
  };

  await app.register(
    async (app) => {
      // Identity out of reach: who the caller stands for can't be worked out, so nothing is let through.
      app.setErrorHandler((err, req, reply) => {
        if (!(err instanceof PeopleUnavailable)) return reply.send(err);
        req.log.error({ err: err.message }, 'could not ask identity who the caller is');
        return reply.code(503).send({ error: 'unavailable', message: 'Mandate can’t check who you are right now. Try again in a moment.' });
      });

      // ---- a floor ----

      /** The intents on this floor: those set here or passed down to it, drafts, and what's closed. */
      app.get('/floor', async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const here = await store.onFloor(v.workspace.id);
        const { sight, byId } = await sightsFor(v, here);
        // What heads this floor's list: intents whose parent is on another floor, or that have none.
        const tops = here.filter((i) => sight.get(i.id) === 'full' && (!i.parent || byId.get(i.parent)?.workspace !== v.workspace.id));
        const counts = (i: Intent) => {
          const below = [...byId.values()].filter((d) => d.ancestors.includes(i.id) && !ended(d) && sight.has(d.id));
          return { parts: below.length, atRisk: below.filter((d) => d.rating === 'at_risk').length, blocked: below.filter((d) => d.rating === 'blocked').length };
        };
        const item = (i: Intent) => ({ ...summaryOf(i, 'full'), counts: counts(i), ...(i.parent ? { partOf: byId.get(i.parent)?.title ?? '' } : {}) });
        return {
          intents: tops.filter((i) => !ended(i) && i.life !== 'draft').map(item),
          drafts: tops.filter((i) => i.life === 'draft' && rightsOn(v, i, undefined).edit).map(item),
          closed: tops.filter(ended).map(item),
          can: { create: maySet(v) },
        };
      });

      /** Sets a new intent on this floor, as a draft for its holder to write and issue. */
      app.post<{ Body: { title: string; floorName?: string } }>(
        '/intents',
        { schema: { body: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: TITLE, floorName: TEXT(120) } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          if (!maySet(v)) return refuse(reply, 'Only the floor’s leads can set intent here. You can set your own on your own floor.');
          const at = stamp();
          const id = newId();
          const personal = v.workspace.kind === 'personal';
          const intent: Intent = {
            id,
            root: id,
            ancestors: [],
            workspace: v.workspace.id,
            floor: floorPrincipal(v.workspace, v.id),
            floorKind: v.workspace.kind,
            floorName: (req.body.floorName ?? '').trim() || (personal ? 'You' : ''),
            holder: personal ? `person:${v.id}` : 'floor',
            holderName: personal ? v.name : (req.body.floorName ?? '').trim(),
            title: req.body.title.trim(),
            life: 'draft',
            version: 0,
            draft: { ...EMPTY_STATEMENT },
            mainEffort: false,
            rhythmDays: 7,
            createdBy: v.id,
            createdByName: v.name,
            createdAt: at,
            updatedAt: at,
          };
          await store.commit({ intents: [intent] });
          await recorded({ actor: v.id, action: 'intent.created', target: id, workspace: intent.workspace, detail: { title: intent.title } });
          return reply.code(201).send(summaryOf(intent, 'full'));
        },
      );

      // ---- one intent ----

      app.get<{ Params: { id: string } }>('/intents/:id', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const loaded = await load(v, req.params.id, reply);
        return loaded ? detailOf(v, loaded) : reply;
      });

      /** Changes the draft: its title, statement, date and rhythm. Issuing makes it the next version. */
      app.patch<{ Params: { id: string }; Body: { title?: string; statement?: Partial<Statement>; byDate?: string | null; rhythmDays?: number } }>(
        '/intents/:id',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: { title: TITLE, statement: STATEMENT, byDate: { anyOf: [DATE, { type: 'null' }] }, rhythmDays: { type: 'integer', minimum: 1, maximum: 90 } },
            },
          },
        },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.edit) return refuse(reply, 'Only whoever holds this intent can change it, while it’s a draft or under way.');
          const { intent } = loaded;
          const next: Intent = {
            ...intent,
            ...(req.body.title ? { title: req.body.title.trim() } : {}),
            draft: req.body.statement ? tidy(req.body.statement, intent.draft) : intent.draft,
            ...(req.body.byDate !== undefined ? { byDate: req.body.byDate ?? undefined } : {}),
            ...(req.body.rhythmDays ? { rhythmDays: req.body.rhythmDays } : {}),
            updatedAt: stamp(),
          };
          if (req.body.byDate === null) delete next.byDate;
          await store.commit({ intents: [next] });
          return detailOf(v, { ...loaded, intent: next, can: rightsOn(v, next, loaded.parent) });
        },
      );

      /** Issues the draft as the next version. Purpose and end state are needed; parts below are asked to confirm their back-brief. */
      app.post<{ Params: { id: string } }>('/intents/:id/issue', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const loaded = await load(v, req.params.id, reply);
        if (!loaded) return reply;
        const { intent, tree } = loaded;
        if (!loaded.can.edit) return refuse(reply, 'Only whoever holds this intent can issue it.');
        if (!intent.draft.purpose || !intent.draft.endState) return reply.code(400).send({ error: 'incomplete', message: 'Say its purpose and its end state before issuing it.' });
        const at = stamp();
        const number = intent.version + 1;
        const next: Intent = { ...intent, version: number, life: intent.life === 'draft' ? 'active' : intent.life, updatedAt: at };
        const ok = await commit(
          {
            intents: [next],
            versions: [{ intent: intent.id, version: number, title: intent.title, statement: intent.draft, issuedBy: v.id, issuedByName: v.name, issuedAt: at }],
            events: [event(TOPICS.issued, intent, { version: number })],
          },
          reply,
        );
        if (!ok) return reply;
        await recorded({ actor: v.id, action: 'intent.issued', target: intent.id, workspace: intent.workspace, detail: { title: intent.title, version: number } });
        // The parts below were back-briefed against the version before: they're asked whether theirs still stands.
        const parts = tree.filter((i) => i.parent === intent.id && !ended(i));
        if (number > 1)
          for (const part of parts)
            await told({
              recipients: await holdersOf(part),
              workspace: part.workspace,
              title: `${intent.title} has changed`,
              detail: `It’s at version ${number}. Check “${part.title}” still fits, and say so.`,
              needsYou: true,
              link: `/intents/${part.id}`,
            });
        return detailOf(v, { ...loaded, intent: next, can: rightsOn(v, next, loaded.parent) });
      });

      /** Who a part can be passed to: teams directly below the intent's floor, and people on it. */
      app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
        '/intents/:id/targets',
        { schema: { params: ID_PARAMS, querystring: { type: 'object', additionalProperties: false, properties: { q: TEXT(100) } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.pass) return refuse(reply, 'Only whoever holds this intent can pass part of it down.');
          const q = req.query.q?.trim();
          const found = q ? await people.directory({ q, limit: 12 }) : { people: [], teams: [] };
          const teams = found.teams.filter((t) => directlyBelow(loaded.intent, t.path));
          const onIt = await Promise.all(found.people.map((p) => onFloorOfIntent(p.id, loaded.intent)));
          return {
            teams: teams.map((t) => ({ to: `team:${t.id}`, name: t.name, within: t.within })),
            people: [
              { to: `person:${v.id}`, name: v.name, you: true },
              ...found.people.filter((p, n) => onIt[n] && p.id !== v.id).map((p) => ({ to: `person:${p.id}`, name: p.name, ...(p.email ? { email: p.email } : {}) })),
            ],
          };
        },
      );

      /** A team is directly below an intent's floor: a top team under the org, or a team whose parent is the intent's team. */
      const directlyBelow = (i: Intent, path: string[] | undefined) =>
        Boolean(path?.length) && (i.floorKind === 'org' ? path!.length === 1 : i.floorKind === 'team' && path!.at(-2) === i.workspace);
      /** Someone stands on an intent's floor: anyone, on the org's; a member, on a team's. */
      const onFloorOfIntent = async (person: string, i: Intent) => {
        if (i.floorKind === 'org') return true;
        if (i.floorKind !== 'team') return false;
        const principals = await people.principals(person, { id: i.workspace, kind: 'team', role: 'member' }).catch((): string[] => []);
        return principals.includes(`team:${i.workspace}`);
      };

      /** Passes part of an intent down: to a team directly below its floor, or a person on it. They back-brief it before it's under way. */
      app.post<{ Params: { id: string }; Body: { to: string; title: string; purpose?: string; byDate?: string; carry?: { entities?: string[]; documents?: string[] } } }>(
        '/intents/:id/pass',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['to', 'title'],
              properties: {
                to: { type: 'string', pattern: '^(team|person):[^\\s:]{1,64}$' },
                title: TITLE,
                purpose: TEXT(2000),
                byDate: DATE,
                carry: { type: 'object', additionalProperties: false, properties: { entities: { type: 'array', maxItems: 50, items: TEXT(300) }, documents: { type: 'array', maxItems: 50, items: TEXT(300) } } },
              },
            },
          },
        },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          const { intent } = loaded;
          if (!loaded.can.pass) return refuse(reply, 'Only whoever holds this intent can pass part of it down, once it’s issued.');
          if (intent.ancestors.length + 1 >= MAX_DEPTH) return unfit(reply, `Intent nests at most ${MAX_DEPTH} deep.`);
          const [kind, target] = req.body.to.split(':') as ['team' | 'person', string];
          let place: Pick<Intent, 'workspace' | 'floor' | 'floorKind' | 'floorName' | 'holder' | 'holderName'>;
          if (kind === 'team') {
            const team = (await people.directory({ ids: [target] })).teams.find((t) => t.id === target);
            if (!team || !directlyBelow(intent, team.path)) return reply.code(400).send({ error: 'bad-target', message: 'Pass a part to a team directly below this floor, or to someone on it.' });
            place = { workspace: team.id, floor: `tree:${team.id}`, floorKind: 'team', floorName: team.name, holder: 'floor', holderName: team.name };
          } else {
            const name = target === v.id ? v.name : (await people.directory({ ids: [target] })).people.find((p) => p.id === target)?.name;
            if (!name || (target !== v.id && !(await onFloorOfIntent(target, intent))))
              return reply.code(400).send({ error: 'bad-target', message: 'Pass a part to a team directly below this floor, or to someone on it.' });
            place = { workspace: intent.workspace, floor: intent.floor, floorKind: intent.floorKind, floorName: intent.floorName, holder: `person:${target}`, holderName: name };
          }
          const at = stamp();
          const id = newId();
          const part: Intent = {
            id,
            parent: intent.id,
            root: intent.root,
            ancestors: [...intent.ancestors, intent.id],
            ...place,
            title: req.body.title.trim(),
            life: 'passed',
            version: 1,
            draft: { ...EMPTY_STATEMENT, purpose: (req.body.purpose ?? '').trim() },
            mainEffort: false,
            ...(req.body.byDate ? { byDate: req.body.byDate } : {}),
            rhythmDays: intent.rhythmDays,
            createdBy: v.id,
            createdByName: v.name,
            passedBy: v.id,
            passedByName: v.name,
            passedAt: at,
            createdAt: at,
            updatedAt: at,
          };
          // Carried down: the parent's bindings the giver chose, marked with where they came from.
          const [entities, documents] = await Promise.all([store.entityBindings([intent.id]), store.documentBindings([intent.id])]);
          const carry = req.body.carry ?? {};
          const carriedEntities: EntityBinding[] = entities
            .filter((b) => carry.entities?.includes(`${b.entity.id}|${b.role}`))
            .map((b) => ({ ...b, intent: id, inheritedFrom: b.inheritedFrom ?? intent.id, boundBy: v.id, at }));
          const carriedDocuments: DocumentBinding[] = documents
            .filter((b) => carry.documents?.includes(`${b.document.app}|${b.document.id}`))
            .map((b) => ({ ...b, intent: id, inheritedFrom: b.inheritedFrom ?? intent.id, boundBy: v.id, at }));
          await store.commit({
            intents: [part],
            versions: [{ intent: id, version: 1, title: part.title, statement: part.draft, issuedBy: v.id, issuedByName: v.name, issuedAt: at }],
            entityBindings: carriedEntities,
            documentBindings: carriedDocuments,
            events: [
              event(TOPICS.passed, part, { parent: intent.id, to: req.body.to }),
              ...carriedEntities.map((b) => event(TOPICS.entityBound, part, { entity: b.entity.id, role: b.role })),
            ],
          });
          await recorded({ actor: v.id, action: 'intent.passed', target: id, workspace: part.workspace, detail: { title: part.title, parent: intent.id, to: req.body.to } });
          await told({
            recipients: (await holdersOf(part)).filter((p) => p !== v.id),
            workspace: part.workspace,
            title: `${v.name} passed you “${part.title}”`,
            detail: kind === 'team' ? `Part of ${intent.title}. A lead of ${part.floorName} says it back to accept it.` : `Part of ${intent.title}. Say it back in your own words to accept it.`,
            needsYou: true,
            link: `/intents/${id}`,
          });
          return reply.code(201).send(summaryOf(part, 'full'));
        },
      );

      /**
       * The receiver says the part back in their own words, and accepts it or
       * raises a concern. After the parent is revised, the same confirms theirs still stands.
       */
      app.post<{ Params: { id: string }; Body: { words: string; concern?: string; outcome: 'accepted' | 'concern' } }>(
        '/intents/:id/back-brief',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['words', 'outcome'],
              properties: { words: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' }, concern: TEXT(4000), outcome: { enum: ['accepted', 'concern'] } },
            },
          },
        },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          const { intent, parent } = loaded;
          if (!loaded.can.backBrief) return refuse(reply, 'Only whoever holds this part can back-brief it, while it waits for one.');
          const concern = (req.body.concern ?? '').trim();
          if (req.body.outcome === 'concern' && !concern) return reply.code(400).send({ error: 'incomplete', message: 'Say what doesn’t fit.' });
          const at = stamp();
          const accepted = req.body.outcome === 'accepted';
          const next: Intent = {
            ...intent,
            ...(accepted ? { life: intent.life === 'passed' ? 'active' : intent.life, briefedParentVersion: parent?.version ?? 0 } : {}),
            updatedAt: at,
          };
          await store.commit({
            intents: [next],
            backBriefs: [{ id: newId(), intent: intent.id, version: intent.version, parentVersion: parent?.version ?? 0, by: v.id, byName: v.name, words: req.body.words.trim(), concern, outcome: req.body.outcome, at }],
            events: accepted ? [event(TOPICS.accepted, intent, { version: intent.version })] : [],
          });
          await recorded({ actor: v.id, action: accepted ? 'intent.accepted' : 'intent.concern-raised', target: intent.id, workspace: intent.workspace, detail: { title: intent.title } });
          await told({
            recipients: giverOf(intent, parent).filter((p) => p !== v.id),
            workspace: parent?.workspace ?? intent.workspace,
            title: accepted ? `${v.name} accepted “${intent.title}”` : `${v.name} raised a concern about “${intent.title}”`,
            detail: accepted ? req.body.words.trim().slice(0, 280) : concern.slice(0, 280),
            needsYou: !accepted,
            link: `/intents/${intent.id}`,
          });
          return detailOf(v, { ...loaded, intent: next, can: rightsOn(v, next, parent) });
        },
      );

      /** The holder says how it's going. "Achieved" is their claim; whoever passed it down closes it. */
      app.post<{ Params: { id: string }; Body: { rating: Rating; note?: string } }>(
        '/intents/:id/assess',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, required: ['rating'], properties: { rating: { enum: RATINGS }, note: TEXT(1000) } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          const { intent, parent } = loaded;
          if (!loaded.can.assess) return refuse(reply, 'Only whoever holds this intent can say how it’s going, while it’s under way.');
          const at = stamp();
          const note = (req.body.note ?? '').trim();
          const next: Intent = { ...intent, rating: req.body.rating, ratedAt: at, updatedAt: at, ...(note ? { ratingNote: note } : {}) };
          if (!note) delete next.ratingNote;
          await store.commit({
            intents: [next],
            assessments: [{ id: newId(), intent: intent.id, by: v.id, byName: v.name, rating: req.body.rating, note, at }],
            events: [event(TOPICS.assessed, intent, { rating: req.body.rating })],
          });
          const changed = intent.rating !== req.body.rating;
          if (changed && req.body.rating !== 'on_track')
            await told({
              recipients: giverOf(intent, parent).filter((p) => p !== v.id),
              workspace: parent?.workspace ?? intent.workspace,
              title: req.body.rating === 'achieved' ? `${v.name} says “${intent.title}” is achieved` : `“${intent.title}” is ${req.body.rating === 'blocked' ? 'blocked' : 'at risk'}`,
              ...(note ? { detail: note.slice(0, 280) } : {}),
              needsYou: req.body.rating === 'achieved' || req.body.rating === 'blocked',
              link: `/intents/${intent.id}`,
            });
          return detailOf(v, { ...loaded, intent: next, can: rightsOn(v, next, parent) });
        },
      );

      /** Ends an intent, and every open part below it: achieved, or withdrawn. */
      const close = async (v: Viewer, loaded: Loaded, life: 'achieved' | 'withdrawn', reason: string, reply: FastifyReply) => {
        const { intent, tree } = loaded;
        const at = stamp();
        const below = tree.filter((d) => d.ancestors.includes(intent.id) && !ended(d));
        const next: Intent = { ...intent, life, endedAt: at, endedReason: reason, updatedAt: at };
        const parts = below.map((d): Intent => ({ ...d, life: life === 'achieved' ? 'superseded' : 'withdrawn', endedAt: at, endedReason: life === 'achieved' ? `${intent.title} was achieved.` : `${intent.title} was withdrawn.`, updatedAt: at }));
        await store.commit({
          intents: [next, ...parts],
          events: [event(life === 'achieved' ? TOPICS.achieved : TOPICS.withdrawn, intent), ...parts.map((p) => event(life === 'achieved' ? TOPICS.superseded : TOPICS.withdrawn, p))],
        });
        await recorded({ actor: v.id, action: `intent.${life}`, target: intent.id, workspace: intent.workspace, detail: { title: intent.title, ...(reason ? { reason } : {}), parts: parts.length } });
        for (const i of [intent, ...below]) {
          const recipients = (await holdersOf(i)).filter((p) => p !== v.id);
          await told({ recipients, workspace: i.workspace, title: `${i === intent ? i.title : intent.title} was ${life === 'achieved' ? 'achieved' : 'withdrawn'}`, ...(i !== intent ? { detail: `So “${i.title}” is closed.` } : reason ? { detail: reason } : {}), link: `/intents/${i.id}` });
        }
        return detailOf(v, { ...loaded, intent: next, tree: tree.map((d) => (d.id === intent.id ? next : (parts.find((p) => p.id === d.id) ?? d))), can: rightsOn(v, next, loaded.parent) });
      };

      app.post<{ Params: { id: string } }>('/intents/:id/achieve', { schema: { params: ID_PARAMS } }, async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const loaded = await load(v, req.params.id, reply);
        if (!loaded) return reply;
        if (!loaded.can.achieve) return refuse(reply, 'Whoever passed this down closes it as achieved, once it’s under way.');
        return close(v, loaded, 'achieved', '', reply);
      });

      app.post<{ Params: { id: string }; Body: { reason?: string } }>(
        '/intents/:id/withdraw',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, properties: { reason: TEXT(1000) } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.withdraw) return refuse(reply, 'Only whoever passed this down, or holds it on its own floor, can withdraw it.');
          return close(v, loaded, 'withdrawn', (req.body?.reason ?? '').trim(), reply);
        },
      );

      /** Marks the part that matters most among its siblings, or unmarks it. One per parent. */
      app.post<{ Params: { id: string }; Body: { on: boolean } }>(
        '/intents/:id/main-effort',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' } } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.mainEffort) return refuse(reply, 'Whoever holds the intent above sets its main effort.');
          const at = stamp();
          const siblings = loaded.tree.filter((i) => i.parent === loaded.intent.parent && i.id !== loaded.intent.id && i.mainEffort);
          const next = { ...loaded.intent, mainEffort: req.body.on, updatedAt: at };
          await store.commit({ intents: [next, ...(req.body.on ? siblings.map((s) => ({ ...s, mainEffort: false, updatedAt: at })) : [])] });
          return detailOf(v, { ...loaded, intent: next, can: rightsOn(v, next, loaded.parent) });
        },
      );

      // ---- what it's bound to ----

      app.post<{ Params: { id: string }; Body: { entity: EntityRef; role: string } }>(
        '/intents/:id/entities',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, required: ['entity', 'role'], properties: { entity: ENTITY_REF, role: { type: 'string', pattern: '^[a-z][a-z-]{1,30}$' } } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.bind) return refuse(reply, 'Only whoever holds this intent can say what it’s about.');
          const { kind, id, type, label } = req.body.entity;
          await store.commit({
            entityBindings: [{ intent: loaded.intent.id, entity: { kind, id, type, label: label ?? '' }, role: req.body.role, boundBy: v.id, at: stamp() }],
            events: [event(TOPICS.entityBound, loaded.intent, { entity: id, role: req.body.role })],
          });
          return detailOf(v, loaded);
        },
      );

      app.delete<{ Params: { id: string; entity: string }; Querystring: { role: string } }>(
        '/intents/:id/entities/:entity',
        {
          schema: {
            params: { type: 'object', properties: { id: TEXT(64), entity: TEXT(200) }, required: ['id', 'entity'] },
            querystring: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: TEXT(32) } },
          },
        },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.bind) return refuse(reply, 'Only whoever holds this intent can say what it’s about.');
          await store.commit({
            unbindEntities: [{ intent: loaded.intent.id, entity: req.params.entity, role: req.query.role }],
            events: [event(TOPICS.entityUnbound, loaded.intent, { entity: req.params.entity, role: req.query.role })],
          });
          return detailOf(v, loaded);
        },
      );

      app.post<{ Params: { id: string }; Body: { document: DocumentRef } }>(
        '/intents/:id/documents',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, required: ['document'], properties: { document: DOCUMENT_REF } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.bind) return refuse(reply, 'Only whoever holds this intent can add documents to it.');
          const { app: from, id, title, version: docVersion } = req.body.document;
          await store.commit({ documentBindings: [{ intent: loaded.intent.id, document: { app: from, id, title, ...(docVersion ? { version: docVersion } : {}) }, boundBy: v.id, at: stamp() }] });
          return detailOf(v, loaded);
        },
      );

      app.delete<{ Params: { id: string; app: string; doc: string } }>(
        '/intents/:id/documents/:app/:doc',
        { schema: { params: { type: 'object', properties: { id: TEXT(64), app: TEXT(40), doc: TEXT(200) }, required: ['id', 'app', 'doc'] } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.bind) return refuse(reply, 'Only whoever holds this intent can take documents off it.');
          await store.commit({ unbindDocuments: [{ intent: loaded.intent.id, app: req.params.app, id: req.params.doc }] });
          return detailOf(v, loaded);
        },
      );

      // ---- for other apps ----

      /**
       * What an intent bounds, for a tool working under it (a briefing, say): its
       * statement and line of sight, and the entities and documents bound to it and
       * to its parts, `depth` levels down, as far as the person sees.
       */
      app.get<{ Params: { id: string }; Querystring: { depth?: number } }>(
        '/intents/:id/context',
        { schema: { params: ID_PARAMS, querystring: { type: 'object', additionalProperties: false, properties: { depth: { type: 'integer', minimum: 0, maximum: 3 } } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          const { intent, tree, sight, byId } = loaded;
          const depth = req.query.depth ?? 1;
          const within = tree.filter((i) => (i.id === intent.id || (i.ancestors.includes(intent.id) && i.ancestors.length - intent.ancestors.length <= depth)) && sight.get(i.id) === 'full' && !ended(i));
          const ids = within.map((i) => i.id);
          const [entities, documents, versions] = await Promise.all([store.entityBindings(ids), store.documentBindings(ids), store.versions(intent.id)]);
          const ref = (i: Intent) => ({ kind: 'intent' as const, app: 'mandate', id: i.id, title: i.title });
          return {
            intent: ref(intent),
            statement: versions[0]?.statement ?? intent.draft,
            lineOfSight: intent.ancestors.map((a) => byId.get(a)).filter((a): a is Intent => Boolean(a)).map(ref),
            entities: entities.map((b) => ({ ref: b.entity, role: b.role, from: ref(byId.get(b.intent)!) })),
            documents: documents.map((b) => ({ ref: b.document, from: ref(byId.get(b.intent)!) })),
            children: tree.filter((i) => i.parent === intent.id && sight.has(i.id)).map((i) => ({ intent: ref(i), life: i.life, ...(i.rating ? { rating: i.rating } : {}) })),
          };
        },
      );

      /** Names intents for another app that links to them (Data Atlas's "used by"): a title, or that the person can't open it. */
      app.post<{ Body: { ids: string[] } }>(
        '/refs/resolve',
        { schema: { body: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', maxItems: 200, items: TEXT(64) } } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const found = await store.intents(req.body.ids);
          const { sight } = await sightsFor(v, found);
          const byId = new Map(found.map((i) => [i.id, i]));
          return {
            refs: req.body.ids.map((id) => {
              const i = byId.get(id);
              const s = sight.get(id);
              return i && s ? { id, label: i.title, canOpen: s === 'full' } : { id, canOpen: false };
            }),
          };
        },
      );

      /** The intents an entity is bound to, that the person can read. */
      app.get<{ Params: { entity: string } }>('/entities/:entity/intents', { schema: { params: { type: 'object', properties: { entity: TEXT(200) }, required: ['entity'] } } }, async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const bindings = await store.boundTo(req.params.entity);
        const found = await store.intents([...new Set(bindings.map((b) => b.intent))]);
        const { sight } = await sightsFor(v, found);
        const byId = new Map(found.map((i) => [i.id, i]));
        return {
          intents: bindings.flatMap((b) => {
            const i = byId.get(b.intent);
            return i && sight.get(i.id) === 'full' ? [{ ...summaryOf(i, 'full'), role: b.role }] : [];
          }),
        };
      });

      /** Find in the shell: intents the person can read, by the words of their title. */
      app.get<{ Querystring: { q?: string } }>('/search', { schema: { querystring: { type: 'object', properties: { q: TEXT(200) } } } }, async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const words = (req.query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
        const found = await store.search(words, 200);
        const { sight, byId } = await sightsFor(v, found);
        return {
          results: found
            .filter((i) => sight.get(i.id) === 'full')
            .slice(0, 20)
            .map((i) => ({
              id: i.id,
              title: i.title,
              detail: [i.parent ? `Part of ${byId.get(i.parent)?.title ?? ''}` : 'Intent', i.floorName, lifeWords[i.life]].filter(Boolean).join(' · '),
              path: `/intents/${encodeURIComponent(i.id)}`,
              // On a team's floor the person is on, it opens there; anything else opens from where they are.
              ...(i.workspace !== v.workspace.id && v.principals.includes(`team:${i.workspace}`) ? { workspace: i.workspace } : {}),
            })),
        };
      });

      // ---- the person ----

      /** What the person holds, or has been passed and not yet accepted, on any floor. */
      app.get('/me', async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        return yours(v);
      });

      /** Home's card: what's waiting for the person, and how this floor's intents are going. */
      app.get('/home', async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        const mine = await yours(v);
        const here = (await store.onFloor(v.workspace.id)).filter((i) => i.life === 'active');
        const { sight } = await sightsFor(v, here);
        const seen = here.filter((i) => sight.get(i.id) === 'full');
        return {
          waiting: [...mine.passed, ...mine.recheck].slice(0, 5),
          due: mine.due.length,
          holding: mine.holding.length,
          floor: { active: seen.length, atRisk: seen.filter((i) => i.rating === 'at_risk').length, blocked: seen.filter((i) => i.rating === 'blocked').length },
        };
      });
    },
    { prefix: `/${API_VERSION}` },
  );
  return app;
};

export type { Rights };
