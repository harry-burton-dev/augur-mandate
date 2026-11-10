import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  appServer,
  floorCaller,
  packageVersion,
  PeopleUnavailable,
  Problem,
  readManifest,
  sendProblem,
  serviceFastifyOptions,
  type AppManifest,
  type CallerCheck,
  type NewInboxItem,
} from '@augur/service-kit';
import type {
  AddDocumentBody,
  AssessBody,
  BackBriefBody,
  BindEntityBody,
  Branch,
  CreateBody,
  Detail,
  EditBody,
  Floor,
  HomeGlance,
  MainEffortBody,
  Message as WireMessage,
  MessageBody,
  PassAgainBody,
  PassBody,
  Rights,
  RevisePartBody,
  SearchResults,
  Summary,
  Targets,
  Thread,
  WithdrawBody,
  Yours,
  AchieveBody,
  CloseChoice,
} from './api-types.ts';
import { auditFromEnv, type Audit } from './audit.ts';
import { bindingOutbox } from './follow.ts';
import { backBriefKey, INBOX_KINDS, inboxFromEnv, needsHolderKey, type MandateInbox } from './inbox.ts';
import { notifyFromEnv, type Notify } from './notices.ts';
import { floorPrincipal, peopleFromEnv, type People } from './people.ts';
import { RULE_MAX, ruleOf, ruleProblem, tidyRule } from './reminders/rules.ts';
import { amongHolders, assessmentDue, discussing, ended, maySet, needsRecheck, rightsOn, sightOf, type Sight, type Viewer } from './rules.ts';
import {
  ConflictError,
  EMPTY_STATEMENT,
  ENDED,
  newId,
  RATINGS,
  TOPICS,
  type Change,
  type DocumentBinding,
  type EntityBinding,
  type Intent,
  type MandateStore,
  type Message,
  type OutboxEvent,
  type Statement,
} from './store.ts';

/** The major version of the API this service serves. Its routes go under /v1, as the platform's do. */
export const API_VERSION = 'v1';
const version = packageVersion(import.meta.url);

/** How deep intents may nest: deeper than any team tree (five), with room for people's parts and phases. */
export const MAX_DEPTH = 8;

export interface Options {
  /** Mandate's manifest; read from manifest.json by default. Its id and name are what Mandate calls itself. */
  manifest?: AppManifest;
  /** Checks the caller the gateway signed for Mandate. In production it is on by default; in dev `x-user-*` headers are believed. */
  callers?: CallerCheck;
  store: MandateStore;
  audit?: Audit;
  notify?: Notify;
  /** Where a part's back-brief waits in the shell's Inbox. */
  inbox?: MandateInbox;
  people?: People;
  now?: () => Date;
}

/** An intent as its summary shows it, and with what's below it (see `api-types.ts`). */
export type { Branch, Summary };

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
  ...(i.briefBy ? { briefBy: i.briefBy } : {}),
  ...(sight === 'full' && i.rating ? { rating: i.rating, ...(i.ratingNote ? { ratingNote: i.ratingNote } : {}), ...(i.ratedAt ? { ratedAt: i.ratedAt } : {}) } : {}),
  ...(sight === 'summary' && i.rating ? { rating: i.rating } : {}),
  ...(i.needsHolder && !ENDED.includes(i.life) ? { needsHolder: i.needsHolder } : {}),
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

export const buildApp = async ({ manifest = readManifest(import.meta.url), callers, store, audit, notify, inbox, people = peopleFromEnv(), now = () => new Date() }: Options) => {
  const app = Fastify(serviceFastifyOptions());
  const record = audit ?? auditFromEnv((entry) => app.log.info({ audit: entry }, 'audit (no audit log here)'));
  const tell = notify ?? notifyFromEnv((notice) => app.log.info({ notice }, 'notification (no notifications here)'));
  const recorded = (entry: Parameters<Audit>[0]) =>
    record(entry).catch((err: Error) => app.log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));
  const told = (notice: Parameters<Notify>[0]) =>
    notice.recipients.length ? tell(notice).catch((err: Error) => app.log.error({ err: err.message, title: notice.title }, 'could not tell people')) : Promise.resolve();
  const work = inbox ?? inboxFromEnv((what) => app.log.info({ inbox: what }, 'inbox item (no inbox here)'));
  const waiting = (key: string, workspace: string, item: NewInboxItem) => work.put(key, workspace, item).catch((err: Error) => app.log.error({ err: err.message, key }, 'could not put work in an inbox'));
  const settled = (key: string, state: 'done' | 'withdrawn') => work.close(key, state).catch((err: Error) => app.log.error({ err: err.message, key }, 'could not close an inbox item'));
  /** A part's back-brief, waiting on whoever holds it: the person, or the team's leads, who say it back for the team. */
  const backBriefItem = (part: Intent, detail: string, from: string, reopen = false): NewInboxItem => {
    const person = personOf(part.holder);
    return {
      kind: INBOX_KINDS.backBrief,
      owner: person ? { kind: 'person', id: person } : { kind: 'team', id: part.workspace, role: 'lead' },
      title: part.title,
      detail,
      subject: { kind: 'ref', app: manifest.id, type: 'intent', id: part.id, label: part.title },
      path: `/intents/${part.id}`,
      // Saying it back is Mandate's own step: a concern is raised there, not by declining.
      allow: { decline: false, handOn: false, selfComplete: false },
      from,
      ...(part.briefBy ? { due: part.briefBy } : {}),
      ...(reopen ? { reopen: true } : {}),
    };
  };

  // Only the gateway's signed word says who is calling; every error is a problem details body; /healthz.
  await appServer(app, { manifest, version, api: API_VERSION, ...(callers ? { callers } : {}) });
  const floorOf = floorCaller(manifest);

  /** Who is calling, on which floor, and who they stand for; or a refusal already sent. Every intent lives on a floor. */
  const viewerOf = async (req: FastifyRequest, reply: FastifyReply): Promise<Viewer | undefined> => {
    let caller;
    try {
      caller = floorOf(req);
    } catch (err) {
      if (!(err instanceof Problem)) throw err;
      void sendProblem(reply, err);
      return undefined;
    }
    const { workspace } = caller;
    return { id: caller.id, name: caller.name, workspace, principals: await people.principals(caller.id, workspace) };
  };

  /** An intent with its whole tree, and how far the viewer sees into it. One they can't see is as good as not there. */
  const load = async (v: Viewer, id: string, reply: FastifyReply) => {
    const found = await store.intent(id);
    const tree = found ? await store.tree(found.root) : [];
    const sight = sightOf(v, tree);
    const intent = tree.find((i) => i.id === id);
    if (!intent || sight.get(id) !== 'full') {
      sendProblem(reply, 404, 'not-found', 'There’s no such intent, or it isn’t one you can read.');
      return undefined;
    }
    const byId = new Map(tree.map((i) => [i.id, i]));
    const parent = intent.parent ? byId.get(intent.parent) : undefined;
    return { intent, tree, sight, byId, parent, can: rightsOn(v, intent, parent) };
  };
  type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

  const refuse = (reply: FastifyReply, message: string) => sendProblem(reply, 403, 'forbidden', message);
  const unfit = (reply: FastifyReply, message: string) => sendProblem(reply, 409, 'not-now', message);

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
  /** The concern still waiting for an answer: the latest one, unless an answer came after it. */
  const openConcern = (messages: readonly Message[]) => {
    const n = messages.map((m) => m.kind).lastIndexOf('concern');
    return n >= 0 && !messages.slice(n + 1).some((m) => m.kind === 'answer') ? messages[n] : undefined;
  };
  const shown = ({ id, kind, words, byName, at, answers }: Message): WireMessage => ({ id, kind, words, byName, at, ...(answers ? { answers } : {}) });

  /** A binding made or taken away, told in ADR 0066's shape. */
  const bindingTold = (i: Intent, entity: string, role: string, change: 'bound' | 'unbound') => bindingOutbox(manifest.id, { intent: i.id, entity, role }, change, i.workspace);

  /** Writes a change, or says someone else changed it first. */
  const commit = async (change: Change, reply: FastifyReply) => {
    try {
      await store.commit(change);
      return true;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      sendProblem(reply, 409, 'changed', 'Someone else changed this intent just now. Reload it and try again.');
      return false;
    }
  };

  /** Everything the intent page shows. */
  const detailOf = async (v: Viewer, { intent, tree, sight, byId, parent, can }: Loaded): Promise<Detail> => {
    const chain = intent.ancestors.map((a) => byId.get(a)).filter((a): a is Intent => Boolean(a));
    const [versions, backBriefs, assessments, entities, documents] = await Promise.all([
      store.versions(intent.id),
      store.backBriefs(intent.id),
      store.assessments(intent.id, 10),
      store.entityBindings([intent.id]),
      store.documentBindings([intent.id]),
    ]);
    const issued = versions[0];
    // Carried down from an intent no longer above it (it let this stand alone): named, and said so.
    const far = [...new Set([...entities, ...documents].map((b) => b.inheritedFrom).filter((id): id is string => Boolean(id) && !byId.has(id!)))];
    const elsewhere = new Map((await store.intents([...far, ...(intent.stoodAlone ? [intent.stoodAlone.from] : [])])).map((i) => [i.id, i.title]));
    const fromTitle = (id: string) => byId.get(id)?.title ?? `${elsewhere.get(id) ?? ''} (no longer above)`;
    const chainVersions = await Promise.all(chain.map((a) => store.versions(a.id).then((vs) => vs[0])));
    return {
      intent: summaryOf(intent, 'full'),
      statement: issued?.statement ?? intent.draft,
      ...(can.edit ? { draft: intent.draft } : {}),
      issued: issued ? { version: issued.version, by: issued.issuedByName, at: issued.issuedAt } : undefined,
      versions: versions.map((x) => ({ version: x.version, title: x.title, by: x.issuedByName, at: x.issuedAt })),
      passed: intent.passedBy ? { by: intent.passedByName, at: intent.passedAt } : undefined,
      rhythmDays: intent.rhythmDays,
      rhythm: ruleOf(intent),
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
      entities: entities.map(({ entity, role, inheritedFrom, at, state, mergedFrom }) => ({
        entity,
        role,
        ...(inheritedFrom ? { from: fromTitle(inheritedFrom) } : {}),
        at,
        ...(state === 'retired' ? { state } : {}),
        ...(mergedFrom ? { mergedFrom } : {}),
      })),
      documents: documents.map(({ document, inheritedFrom, at }) => ({ document, ...(inheritedFrom ? { from: fromTitle(inheritedFrom) } : {}), at })),
      ...(intent.stoodAlone ? { stoodAlone: { from: elsewhere.get(intent.stoodAlone.from) ?? '', at: intent.stoodAlone.at } } : {}),
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
  const yours = async (v: Viewer): Promise<Yours> => {
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
        return sendProblem(reply, 503, 'unavailable', `${manifest.name} can’t check who you are right now. Try again in a moment.`);
      });

      // ---- a floor ----

      /** The intents on this floor: those set here or passed down to it, drafts, and what's closed. */
      app.get('/floor', async (req, reply): Promise<Floor | FastifyReply> => {
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
      app.post<{ Body: CreateBody }>(
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
      app.patch<{ Params: { id: string }; Body: EditBody }>(
        '/intents/:id',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: { title: TITLE, statement: STATEMENT, byDate: { anyOf: [DATE, { type: 'null' }] }, rhythmDays: { type: 'integer', minimum: 1, maximum: 90 }, rhythm: { anyOf: [{ type: 'null' }, TEXT(RULE_MAX)] } },
            },
          },
        },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.edit) return refuse(reply, 'Only whoever holds this intent can change it, while it’s a draft or under way.');
          const rhythmProblem = req.body.rhythm ? ruleProblem(req.body.rhythm) : undefined;
          if (rhythmProblem) return sendProblem(reply, 400, 'bad-rhythm', rhythmProblem);
          const { intent } = loaded;
          const next: Intent = {
            ...intent,
            ...(req.body.title ? { title: req.body.title.trim() } : {}),
            draft: req.body.statement ? tidy(req.body.statement, intent.draft) : intent.draft,
            ...(req.body.byDate !== undefined ? { byDate: req.body.byDate ?? undefined } : {}),
            ...(req.body.rhythmDays ? { rhythmDays: req.body.rhythmDays } : {}),
            ...(req.body.rhythm ? { rhythm: tidyRule(req.body.rhythm) } : {}),
            updatedAt: stamp(),
          };
          if (req.body.byDate === null) delete next.byDate;
          if (req.body.rhythm === null) delete next.rhythm;
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
        if (!intent.draft.purpose || !intent.draft.endState) return sendProblem(reply, 400, 'incomplete', 'Say its purpose and its end state before issuing it.');
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
              link: `/intents/${part.id}`,
            });
        if (number > 1)
          for (const part of parts) await waiting(backBriefKey(part.id), part.workspace, backBriefItem(part, `${intent.title} is at version ${number}. Say whether this still fits.`, v.id, true));
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
          } satisfies Targets;
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

      const BAD_TARGET = 'Pass a part to a team directly below this floor, or to someone on it.';
      type Place = Pick<Intent, 'workspace' | 'floor' | 'floorKind' | 'floorName' | 'holder' | 'holderName'>;
      /** Where a part of `intent` passed `to` someone sits: a team directly below its floor, or a person on it. Undefined when it can't go there. */
      const placeFor = async (v: Viewer, intent: Intent, to: string): Promise<Place | undefined> => {
        const [kind, target] = to.split(':') as ['team' | 'person', string];
        if (kind === 'team') {
          const team = (await people.directory({ ids: [target] })).teams.find((t) => t.id === target);
          if (!team || !directlyBelow(intent, team.path)) return undefined;
          return { workspace: team.id, floor: `tree:${team.id}`, floorKind: 'team', floorName: team.name, holder: 'floor', holderName: team.name };
        }
        const name = target === v.id ? v.name : (await people.directory({ ids: [target] })).people.find((p) => p.id === target)?.name;
        if (!name || (target !== v.id && !(await onFloorOfIntent(target, intent)))) return undefined;
        return { workspace: intent.workspace, floor: intent.floor, floorKind: intent.floorKind, floorName: intent.floorName, holder: `person:${target}`, holderName: name };
      };
      const TO = { type: 'string', pattern: '^(team|person):[^\\s:]{1,64}$' } as const;

      /** Passes part of an intent down: to a team directly below its floor, or a person on it. They back-brief it before it's under way. */
      app.post<{ Params: { id: string }; Body: PassBody }>(
        '/intents/:id/pass',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['to', 'title'],
              properties: {
                to: TO,
                title: TITLE,
                purpose: TEXT(2000),
                byDate: DATE,
                briefBy: DATE,
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
          const kind = req.body.to.startsWith('team:') ? 'team' : 'person';
          const place = await placeFor(v, intent, req.body.to);
          if (!place) return sendProblem(reply, 400, 'bad-target', BAD_TARGET);
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
            ...(req.body.briefBy ? { briefBy: req.body.briefBy } : {}),
            rhythmDays: intent.rhythmDays,
            ...(intent.rhythm ? { rhythm: intent.rhythm } : {}),
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
              ...carriedEntities.map((b) => bindingTold(part, b.entity.id, b.role, 'bound')),
            ],
          });
          await recorded({ actor: v.id, action: 'intent.passed', target: id, workspace: part.workspace, detail: { title: part.title, parent: intent.id, to: req.body.to } });
          await told({
            recipients: (await holdersOf(part)).filter((p) => p !== v.id),
            workspace: part.workspace,
            title: `${v.name} passed you “${part.title}”`,
            detail: kind === 'team' ? `Part of ${intent.title}. A lead of ${part.floorName} says it back to accept it.` : `Part of ${intent.title}. Say it back in your own words to accept it.`,
            link: `/intents/${id}`,
          });
          await waiting(backBriefKey(id), part.workspace, backBriefItem(part, `Part of ${intent.title}. Say it back in your own words to accept it.`, v.id));
          return reply.code(201).send(summaryOf(part, 'full'));
        },
      );

      /**
       * Passes a part whose holder can no longer hold it to someone new, as the first pass could have:
       * a team directly below the floor above, or a person on it. Its statement and bindings stay; the new
       * holder says it back before it's under way again.
       */
      app.post<{ Params: { id: string }; Body: PassAgainBody }>(
        '/intents/:id/pass-again',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: TO } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          const { intent, parent } = loaded;
          if (!loaded.can.passAgain || !parent)
            return intent.needsHolder ? refuse(reply, 'Whoever passed this down, or a lead of the floor above, passes it again.') : unfit(reply, 'It still has a holder: only a part whose holder can no longer hold it is passed again.');
          const place = await placeFor(v, parent, req.body.to);
          if (!place) return sendProblem(reply, 400, 'bad-target', BAD_TARGET);
          const at = stamp();
          const { needsHolder: _, briefedParentVersion: __, ...rest } = intent;
          const next: Intent = { ...rest, ...place, life: 'passed', passedBy: v.id, passedByName: v.name, passedAt: at, updatedAt: at };
          await store.commit({ intents: [next], events: [event(TOPICS.passed, next, { parent: parent.id, to: req.body.to, again: true })] });
          await recorded({ actor: v.id, action: 'intent.passed-again', target: intent.id, workspace: next.workspace, detail: { title: intent.title, from: intent.holder, to: req.body.to } });
          await settled(needsHolderKey(intent.id), 'done');
          await told({
            recipients: (await holdersOf(next)).filter((p) => p !== v.id),
            workspace: next.workspace,
            title: `${v.name} passed you “${next.title}”`,
            detail: `Part of ${parent.title}, held before by ${intent.holderName}. Say it back in your own words to accept it.`,
            link: `/intents/${next.id}`,
          });
          await waiting(backBriefKey(next.id), next.workspace, backBriefItem(next, `Part of ${parent.title}. Say it back in your own words to accept it.`, v.id, true));
          const tree = loaded.tree.map((d) => (d.id === next.id ? next : d));
          return detailOf(v, { ...loaded, intent: next, tree, can: rightsOn(v, next, parent) });
        },
      );

      /**
       * The receiver says the part back in their own words, and accepts it or
       * raises a concern. After the parent is revised, the same confirms theirs still stands.
       */
      app.post<{ Params: { id: string }; Body: BackBriefBody }>(
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
          if (req.body.outcome === 'concern' && !concern) return sendProblem(reply, 400, 'incomplete', 'Say what doesn’t fit.');
          const at = stamp();
          const accepted = req.body.outcome === 'accepted';
          const next: Intent = {
            ...intent,
            ...(accepted ? { life: intent.life === 'passed' ? 'active' : intent.life, briefedParentVersion: parent?.version ?? 0 } : {}),
            updatedAt: at,
          };
          // A concern is also the discussion's first word on it, so the discussion is the one place to read it.
          const message: Message | undefined = accepted ? undefined : { id: newId(), intent: intent.id, kind: 'concern', words: concern, by: v.id, byName: v.name, at };
          await store.commit({
            intents: [next],
            backBriefs: [{ id: newId(), intent: intent.id, version: intent.version, parentVersion: parent?.version ?? 0, by: v.id, byName: v.name, words: req.body.words.trim(), concern, outcome: req.body.outcome, at }],
            ...(message ? { messages: [message] } : {}),
            events: accepted ? [event(TOPICS.accepted, intent, { version: intent.version })] : [event(TOPICS.discussed, intent, { message: message!.id, kind: 'concern' })],
          });
          await recorded({ actor: v.id, action: accepted ? 'intent.accepted' : 'intent.concern-raised', target: intent.id, workspace: intent.workspace, detail: { title: intent.title } });
          // Said back: the work is done. A concern leaves it waiting, for the answer and another try.
          if (accepted) await settled(backBriefKey(intent.id), 'done');
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

      // ---- discussion (MB2) ----

      const REF = {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'app', 'type', 'id'],
        properties: { kind: { const: 'ref' }, app: TEXT(40), type: TEXT(40), id: TEXT(64) },
      } as const;
      /** The intent a ref names, loaded as the viewer sees it; or a refusal sent. Only Mandate's intents have discussions for now. */
      const discussed = async (v: Viewer, ref: { app: string; type: string; id: string }, reply: FastifyReply) => {
        if (ref.app !== manifest.id || ref.type !== 'intent') {
          sendProblem(reply, 400, 'bad-ref', 'Only intents have discussions for now.');
          return undefined;
        }
        const loaded = await load(v, ref.id, reply);
        if (!loaded) return undefined;
        const messages = await store.messages(ref.id);
        const open = openConcern(messages);
        return { loaded, messages, open, may: discussing(v, loaded.intent, loaded.parent, Boolean(open)) };
      };
      /** Who answers a part's concerns: whoever passed it down, by name. */
      const giverName = (i: Intent, parent?: Intent) => i.passedByName || parent?.holderName || '';

      /** An intent's discussion, for whoever sees it in full. Summary sight answers 404: the parts beside yours don't read each other's. */
      app.get<{ Querystring: { app: string; type: string; id: string } }>(
        '/threads',
        { schema: { querystring: { type: 'object', additionalProperties: false, required: ['app', 'type', 'id'], properties: { app: TEXT(40), type: TEXT(40), id: TEXT(64) } } } },
        async (req, reply): Promise<Thread | FastifyReply> => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const found = await discussed(v, req.query, reply);
          if (!found) return reply;
          const { loaded, messages, open, may } = found;
          return {
            ref: { kind: 'ref', app: manifest.id, type: 'intent', id: loaded.intent.id },
            messages: messages.map(shown),
            ...(open ? { waiting: { concern: open.id, on: giverName(loaded.intent, loaded.parent) } } : {}),
            can: { write: may.kinds.length > 0, kinds: may.kinds, ...(may.why ? { why: may.why } : {}) },
          };
        },
      );

      /** Sends a message: a concern or a note from whoever holds it, an answer or a note from whoever passed it down. The other side is told. */
      app.post<{ Body: MessageBody }>(
        '/threads/messages',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['ref', 'kind', 'words'],
              properties: { ref: REF, kind: { enum: ['concern', 'answer', 'note'] }, words: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' } },
            },
          },
        },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const found = await discussed(v, req.body.ref, reply);
          if (!found) return reply;
          const { loaded, open, may } = found;
          const { intent, parent } = loaded;
          if (ended(intent)) return unfit(reply, may.why ?? 'It’s closed, so its discussion is too.');
          if (!may.kinds.includes(req.body.kind))
            return refuse(reply, req.body.kind === 'answer' && may.kinds.length ? 'There’s no concern waiting for an answer.' : (may.why ?? 'Only whoever holds this part raises a concern; whoever passed it down answers one.'));
          const at = stamp();
          const words = req.body.words.trim();
          const message: Message = { id: newId(), intent: intent.id, kind: req.body.kind, words, by: v.id, byName: v.name, at, ...(req.body.kind === 'answer' && open ? { answers: open.id } : {}) };
          await store.commit({ messages: [message], events: [event(TOPICS.discussed, intent, { message: message.id, kind: message.kind })] });
          await recorded({ actor: v.id, action: 'intent.discussed', target: intent.id, workspace: intent.workspace, detail: { kind: message.kind } });
          // Whoever holds it writes to whoever passed it down, and the other way round.
          const holderSide = amongHolders(v, intent) && req.body.kind !== 'answer';
          await told({
            recipients: (holderSide ? giverOf(intent, parent) : await holdersOf(intent)).filter((p) => p !== v.id),
            workspace: holderSide ? (parent?.workspace ?? intent.workspace) : intent.workspace,
            title: { concern: `${v.name} raised a concern about “${intent.title}”`, answer: `${v.name} answered your concern about “${intent.title}”`, note: `${v.name} wrote about “${intent.title}”` }[message.kind],
            detail: words.slice(0, 280),
            needsYou: message.kind === 'concern',
            link: `/intents/${intent.id}#discussion`,
          });
          return reply.code(201).send(shown(message));
        },
      );

      /**
       * The giver changes a part that waits for its back-brief: its name and why it matters. It's issued as the
       * next version, the holder is asked to say it back again, and a concern waiting on it gets the change as its answer.
       */
      app.patch<{ Params: { id: string }; Body: RevisePartBody }>(
        '/intents/:id/passed',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: TITLE, purpose: TEXT(2000) } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          const { intent, parent } = loaded;
          if (!loaded.can.revisePart)
            return intent.life === 'active' && rightsOn(v, { ...intent, life: 'passed' }, parent).revisePart
              ? unfit(reply, 'It’s been accepted: change your own intent, and they’ll be asked to confirm theirs still fits.')
              : refuse(reply, 'Only whoever passed this part down changes it, while it waits for its back-brief.');
          const at = stamp();
          const number = intent.version + 1;
          const title = req.body.title?.trim() || intent.title;
          const draft = { ...intent.draft, ...(req.body.purpose !== undefined ? { purpose: req.body.purpose.trim() } : {}) };
          const next: Intent = { ...intent, title, draft, version: number, updatedAt: at };
          const changed = [title !== intent.title ? `its name is now “${title}”` : '', draft.purpose !== intent.draft.purpose ? 'why it matters' : ''].filter(Boolean).join(', and ');
          const open = openConcern(await store.messages(intent.id));
          const answer: Message | undefined = open ? { id: newId(), intent: intent.id, kind: 'answer', words: `Changed what was passed: ${changed || 'nothing but the version'}.`, answers: open.id, by: v.id, byName: v.name, at } : undefined;
          const ok = await commit(
            {
              intents: [next],
              versions: [{ intent: intent.id, version: number, title, statement: draft, issuedBy: v.id, issuedByName: v.name, issuedAt: at }],
              ...(answer ? { messages: [answer] } : {}),
              events: [event(TOPICS.issued, intent, { version: number }), ...(answer ? [event(TOPICS.discussed, intent, { message: answer.id, kind: 'answer' })] : [])],
            },
            reply,
          );
          if (!ok) return reply;
          await recorded({ actor: v.id, action: 'intent.revised-part', target: intent.id, workspace: intent.workspace, detail: { title, version: number } });
          await told({
            recipients: (await holdersOf(next)).filter((p) => p !== v.id),
            workspace: next.workspace,
            title: `${v.name} changed “${title}”`,
            detail: `Read what changed, then say it back to accept it.`,
            link: `/intents/${intent.id}`,
          });
          await waiting(backBriefKey(intent.id), intent.workspace, backBriefItem(next, `${v.name} changed what was passed. Say it back in your own words to accept it.`, v.id, true));
          return detailOf(v, { ...loaded, intent: next, tree: loaded.tree.map((d) => (d.id === next.id ? next : d)), can: rightsOn(v, next, parent) });
        },
      );

      /** The holder says how it's going. "Achieved" is their claim; whoever passed it down closes it. */
      app.post<{ Params: { id: string }; Body: AssessBody }>(
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
      /**
       * Lets the open parts below an intent stand alone (MB4): each part directly below becomes the root of
       * its own tree, and its own parts come with it. They keep their holders, statements and bindings.
       */
      const standAlone = (intent: Intent, below: readonly Intent[], at: string): Intent[] => {
        const tops = below.filter((d) => d.parent === intent.id);
        return below.map((d): Intent => {
          const top = tops.find((t) => t.id === d.id || d.ancestors.includes(t.id))!;
          if (d.id !== top.id) return { ...d, root: top.id, ancestors: d.ancestors.slice(d.ancestors.indexOf(top.id)), updatedAt: at };
          const { parent: _, briefedParentVersion: __, ...rest } = d;
          return { ...rest, root: d.id, ancestors: [], mainEffort: false, stoodAlone: { from: intent.id, at }, updatedAt: at };
        });
      };

      /** Ends an intent: achieved, or withdrawn. The open parts below close with it, or stand alone. */
      const close = async (v: Viewer, loaded: Loaded, life: 'achieved' | 'withdrawn', reason: string, choice: CloseChoice = 'close') => {
        const { intent, tree } = loaded;
        const at = stamp();
        const below = tree.filter((d) => d.ancestors.includes(intent.id) && !ended(d));
        const next: Intent = { ...intent, life, endedAt: at, endedReason: reason, updatedAt: at };
        if (choice === 'stand-alone') {
          const lifted = standAlone(intent, below, at);
          const tops = lifted.filter((d) => d.stoodAlone?.from === intent.id);
          await store.commit({
            intents: [next, ...lifted],
            events: [event(life === 'achieved' ? TOPICS.achieved : TOPICS.withdrawn, intent), ...tops.map((t) => event(TOPICS.stoodAlone, t, { from: intent.id }))],
          });
          await recorded({ actor: v.id, action: `intent.${life}`, target: intent.id, workspace: intent.workspace, detail: { title: intent.title, ...(reason ? { reason } : {}), stoodAlone: tops.length } });
          for (const t of tops) {
            await recorded({ actor: v.id, action: 'intent.stood-alone', target: t.id, workspace: t.workspace, detail: { title: t.title, from: intent.id } });
            const recipients = (await holdersOf(t)).filter((p) => p !== v.id);
            await told({ recipients, workspace: t.workspace, title: `${intent.title} was ${life === 'achieved' ? 'achieved' : 'withdrawn'}`, detail: `“${t.title}” stands on its own now.`, link: `/intents/${t.id}` });
          }
          if (intent.needsHolder) await settled(needsHolderKey(intent.id), 'withdrawn');
          return detailOf(v, { ...loaded, intent: next, tree: tree.map((d) => (d.id === intent.id ? next : d)).filter((d) => !lifted.some((l) => l.id === d.id)), can: rightsOn(v, next, loaded.parent) });
        }
        const parts = below.map((d): Intent => ({ ...d, life: life === 'achieved' ? 'superseded' : 'withdrawn', endedAt: at, endedReason: life === 'achieved' ? `${intent.title} was achieved.` : `${intent.title} was withdrawn.`, updatedAt: at }));
        await store.commit({
          intents: [next, ...parts],
          events: [event(life === 'achieved' ? TOPICS.achieved : TOPICS.withdrawn, intent), ...parts.map((p) => event(life === 'achieved' ? TOPICS.superseded : TOPICS.withdrawn, p))],
        });
        await recorded({ actor: v.id, action: `intent.${life}`, target: intent.id, workspace: intent.workspace, detail: { title: intent.title, ...(reason ? { reason } : {}), parts: parts.length } });
        // A back-brief still waiting has nothing left to say back to.
        for (const d of [intent, ...below]) if (d.life === 'passed' || needsRecheck(d, d.parent ? loaded.byId.get(d.parent) : undefined)) await settled(backBriefKey(d.id), 'withdrawn');
        for (const d of [intent, ...below]) if (d.needsHolder) await settled(needsHolderKey(d.id), 'withdrawn');
        for (const i of [intent, ...below]) {
          const recipients = (await holdersOf(i)).filter((p) => p !== v.id);
          await told({ recipients, workspace: i.workspace, title: `${i === intent ? i.title : intent.title} was ${life === 'achieved' ? 'achieved' : 'withdrawn'}`, ...(i !== intent ? { detail: `So “${i.title}” is closed.` } : reason ? { detail: reason } : {}), link: `/intents/${i.id}` });
        }
        return detailOf(v, { ...loaded, intent: next, tree: tree.map((d) => (d.id === intent.id ? next : (parts.find((p) => p.id === d.id) ?? d))), can: rightsOn(v, next, loaded.parent) });
      };

      const CHOICE = { enum: ['close', 'stand-alone'] } as const;
      app.post<{ Params: { id: string }; Body: AchieveBody | undefined }>(
        '/intents/:id/achieve',
        { schema: { params: ID_PARAMS, body: { type: ['object', 'null'], additionalProperties: false, properties: { parts: CHOICE } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.achieve) return refuse(reply, 'Whoever passed this down closes it as achieved, once it’s under way.');
          return close(v, loaded, 'achieved', '', req.body?.parts);
        },
      );

      app.post<{ Params: { id: string }; Body: WithdrawBody }>(
        '/intents/:id/withdraw',
        { schema: { params: ID_PARAMS, body: { type: 'object', additionalProperties: false, properties: { reason: TEXT(1000), parts: CHOICE } } } },
        async (req, reply) => {
          const v = await viewerOf(req, reply);
          if (!v) return reply;
          const loaded = await load(v, req.params.id, reply);
          if (!loaded) return reply;
          if (!loaded.can.withdraw) return refuse(reply, 'Only whoever passed this down, or holds it on its own floor, can withdraw it.');
          return close(v, loaded, 'withdrawn', (req.body?.reason ?? '').trim(), req.body?.parts);
        },
      );

      /** Marks the part that matters most among its siblings, or unmarks it. One per parent. */
      app.post<{ Params: { id: string }; Body: MainEffortBody }>(
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

      app.post<{ Params: { id: string }; Body: BindEntityBody }>(
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
            events: [bindingTold(loaded.intent, id, req.body.role, 'bound')],
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
            events: [bindingTold(loaded.intent, req.params.entity, req.query.role, 'unbound')],
          });
          return detailOf(v, loaded);
        },
      );

      app.post<{ Params: { id: string }; Body: AddDocumentBody }>(
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
          const ref = (i: Intent) => ({ kind: 'intent' as const, app: manifest.id, id: i.id, title: i.title });
          return {
            intent: ref(intent),
            statement: versions[0]?.statement ?? intent.draft,
            lineOfSight: intent.ancestors.map((a) => byId.get(a)).filter((a): a is Intent => Boolean(a)).map(ref),
            entities: entities.map((b) => ({ ref: b.entity, role: b.role, from: ref(byId.get(b.intent)!), ...(b.state === 'retired' ? { state: b.state } : {}) })),
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
        } satisfies SearchResults;
      });

      // ---- the person ----

      /** What the person holds, or has been passed and not yet accepted, on any floor. */
      app.get('/me', async (req, reply) => {
        const v = await viewerOf(req, reply);
        if (!v) return reply;
        return yours(v);
      });

      /** Home's card: what's waiting for the person, and how this floor's intents are going. */
      app.get('/home', async (req, reply): Promise<HomeGlance | FastifyReply> => {
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
