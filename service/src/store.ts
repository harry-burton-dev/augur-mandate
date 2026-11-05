import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations, steadyPool, type Migration } from '@augur/service-kit';
import type * as Wire from './api-types.ts';

/**
 * Mandate's records. An intent is one row that refers to its parent; what
 * kind of intent it is (an operation, a team's part, a person's task) is never
 * stored, only read from where it sits. Statements are versioned and a version
 * is never changed once issued. See apps/mandate/README.md.
 */

/** Where an intent is in its life. Separate from how its holder judges it is going (`Rating`). */
export const LIVES = ['draft', 'passed', 'active', 'achieved', 'superseded', 'withdrawn'] as const satisfies readonly Life[];
export type Life = Wire.Life;
/** Lives that are over: kept, shown under "Closed", never changed again. */
export const ENDED: readonly Life[] = ['achieved', 'superseded', 'withdrawn'];

export const RATINGS = ['on_track', 'at_risk', 'blocked', 'achieved'] as const satisfies readonly Rating[];
export type Rating = Wire.Rating;

/** The roles an entity plays in an intent, agreed with Data Atlas. An open string; these four are documented. */
export const ROLES = ['subject', 'resource', 'area', 'related'] as const;

/** An intent in words, in the shape allied orders use (see `api-types.ts`). */
export type Statement = Wire.Statement;

export const EMPTY_STATEMENT: Statement = { mission: '', purpose: '', endState: '', keyTasks: [], constraints: '', restraints: '', freedoms: '' };

export interface Intent {
  id: string;
  parent?: string;
  root: string;
  /** Its ancestors' ids, from the root down to its parent. */
  ancestors: string[];
  /** The floor it belongs to. */
  workspace: string;
  /** Who its floor lets in: `person:<id>`, `tree:<team>` or `org`. */
  floor: string;
  floorKind: Wire.FloorKind;
  floorName: string;
  /** `person:<id>`, or `floor`: the leads of its floor hold it for the team. */
  holder: string;
  holderName: string;
  title: string;
  life: Life;
  /** The latest issued version; 0 while it has never been issued. */
  version: number;
  /** The statement as its holder is writing it; issuing makes it the next version. */
  draft: Statement;
  /** The parent's version the holder last back-briefed against: when the parent moves on, they confirm again. */
  briefedParentVersion?: number;
  /** The one part under its parent that matters most, set by the parent's holder. */
  mainEffort: boolean;
  /** When it should be done by (YYYY-MM-DD). */
  byDate?: string;
  /** How often its holder is asked for an assessment, in days: the rule `FREQ=DAILY;INTERVAL=<days>` unless `rhythm` says otherwise. */
  rhythmDays: number;
  /** How often its holder is asked for an assessment, as an RFC 5545 RRULE without DTSTART (ADR 0061). */
  rhythm?: string;
  /** When a part passed down should be back-briefed by (YYYY-MM-DD). */
  briefBy?: string;
  /** It was a part of this intent until that closed and let it stand alone (MB4), and when. */
  stoodAlone?: { from: string; at: string };
  /** The holder's latest judgement. */
  rating?: Rating;
  ratingNote?: string;
  ratedAt?: string;
  createdBy: string;
  createdByName: string;
  passedBy?: string;
  passedByName?: string;
  passedAt?: string;
  endedAt?: string;
  endedReason?: string;
  /** Its holder no longer can (MB1). The holder is kept, so the page can say who held it. */
  needsHolder?: Wire.NeedsHolder;
  createdAt: string;
  updatedAt: string;
}

export interface Version {
  intent: string;
  version: number;
  title: string;
  statement: Statement;
  issuedBy: string;
  issuedByName: string;
  issuedAt: string;
}

/** A back-brief as kept: what the page shows, and who gave it and to which intent. */
export interface BackBrief extends Wire.BackBrief {
  intent: string;
  by: string;
}

/** An assessment as kept: what the page shows, and who made it and of which intent. */
export interface Assessment extends Wire.Assessment {
  intent: string;
  by: string;
}

/** A message as kept: what the page shows, and who sent it about which intent. */
export interface Message extends Wire.Message {
  intent: string;
  by: string;
}

/** An entity from Data Atlas, as Mandate keeps a reference to it. The label is a cached name and may be stale. */
export interface EntityRef extends Omit<Wire.EntityRef, 'label' | 'at'> {
  label: string;
}

/** A document, as apps pass them (the SDK's DocumentRef). */
export type DocumentRef = Wire.DocumentRef;

/**
 * How a binding's entity stands in Data Atlas. `merged`: the entity was merged into another that this
 * intent was already bound to in the same role, so the row is kept, out of sight, in case the merge is undone.
 */
export type BindingState = Wire.EntityState | 'merged';

export interface EntityBinding {
  intent: string;
  entity: EntityRef;
  role: string;
  /** Active unless Data Atlas said otherwise. */
  state?: Exclude<BindingState, 'active'>;
  /** The entity it pointed at before Data Atlas merged that one into this one. */
  mergedFrom?: string;
  /** The ancestor it was carried down from, when it was. */
  inheritedFrom?: string;
  boundBy: string;
  at: string;
}

export interface DocumentBinding {
  intent: string;
  document: DocumentRef;
  inheritedFrom?: string;
  boundBy: string;
  at: string;
}

/** What Mandate tells other apps (docs/domain-events.md): ids and a little context, never statements. */
export const TOPICS = {
  issued: 'mandate.intent.issued',
  passed: 'mandate.intent.passed',
  accepted: 'mandate.intent.accepted',
  assessed: 'mandate.intent.assessed',
  achieved: 'mandate.intent.achieved',
  withdrawn: 'mandate.intent.withdrawn',
  superseded: 'mandate.intent.superseded',
  entityBound: 'mandate.intent.entity-bound',
  entityUnbound: 'mandate.intent.entity-unbound',
  needsHolder: 'mandate.intent.needs-holder',
  discussed: 'mandate.intent.discussed',
  stoodAlone: 'mandate.intent.stood-alone',
} as const;

export interface OutboxEvent {
  topic: string;
  workspace: string;
  payload: Record<string, unknown>;
}

/**
 * One change, written all at once with the events that tell of it: rows to
 * put (whole, replacing what was there), rows to add, bindings to take away.
 */
export interface Change {
  intents?: Intent[];
  versions?: Version[];
  backBriefs?: BackBrief[];
  assessments?: Assessment[];
  messages?: Message[];
  entityBindings?: EntityBinding[];
  documentBindings?: DocumentBinding[];
  unbindEntities?: { intent: string; entity: string; role: string }[];
  unbindDocuments?: { intent: string; app: string; id: string }[];
  /** Data Atlas changed how an entity stands: every binding of it, in any role, takes the state. */
  entityStates?: { entity: string; state: 'active' | 'retired' }[];
  /** One binding's state, as a merge leaves or a split restores it. */
  bindingStates?: { intent: string; entity: string; role: string; state: BindingState }[];
  events?: OutboxEvent[];
}

/** Someone else issued the same version first: the change is refused whole. */
export class ConflictError extends Error {}

export interface MandateStore {
  intent(id: string): Promise<Intent | undefined>;
  /** Every intent in one tree, root first, then down the tree. */
  tree(root: string): Promise<Intent[]>;
  /** The intents on a floor. */
  onFloor(workspace: string): Promise<Intent[]>;
  /** The intents a person holds themselves, on any floor. */
  heldBy(person: string): Promise<Intent[]>;
  intents(ids: readonly string[]): Promise<Intent[]>;
  /** Intents whose title has every word, newest first: candidates for Find, before anyone's sight is checked. */
  search(words: readonly string[], limit: number): Promise<Intent[]>;
  versions(intent: string): Promise<Version[]>;
  backBriefs(intent: string): Promise<BackBrief[]>;
  assessments(intent: string, limit?: number): Promise<Assessment[]>;
  /** An intent's discussion, oldest first. */
  messages(intent: string): Promise<Message[]>;
  entityBindings(intents: readonly string[]): Promise<EntityBinding[]>;
  documentBindings(intents: readonly string[]): Promise<DocumentBinding[]>;
  /** The bindings of one entity: what Data Atlas shows as "used by". With `hidden`, the merged-away rows too. */
  boundTo(entity: string, hidden?: boolean): Promise<EntityBinding[]>;
  /** The bindings a merge moved here from this entity. */
  mergedFrom(entity: string): Promise<EntityBinding[]>;
  commit(change: Change): Promise<void>;
  /** The last platform event Mandate has handled, so following picks up where it left off. */
  cursor(): Promise<string | undefined>;
  saveCursor(seq: string): Promise<void>;
}

export const newId = () => randomUUID();

/** Mandate's schema, oldest first. Once released, a migration never changes (scripts/check-migrations.mjs). */
export const migrations: readonly Migration[] = [
  {
    id: '001_intents',
    sql: `
      create table mandate.intents (
        id text primary key,
        parent_id text references mandate.intents (id),
        root_id text not null,
        ancestors text[] not null default '{}',
        workspace_id text not null,
        floor_principal text not null,
        floor_kind text not null,
        floor_name text not null default '',
        holder text not null,
        holder_name text not null default '',
        title text not null,
        life text not null,
        version integer not null default 0,
        draft jsonb not null,
        briefed_parent_version integer,
        main_effort boolean not null default false,
        by_date date,
        rhythm_days integer not null default 7,
        rating text,
        rating_note text,
        rated_at timestamptz,
        created_by text not null,
        created_by_name text not null default '',
        passed_by text,
        passed_by_name text,
        passed_at timestamptz,
        ended_at timestamptz,
        ended_reason text,
        -- Reserved for a protective marking, should AUGUR take them: every read already passes one access check.
        marking text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index intents_root on mandate.intents (root_id);
      create index intents_floor on mandate.intents (workspace_id);
      create index intents_holder on mandate.intents (holder);
      create index intents_ancestors on mandate.intents using gin (ancestors);

      create table mandate.versions (
        intent_id text not null references mandate.intents (id),
        version integer not null,
        title text not null,
        statement jsonb not null,
        issued_by text not null,
        issued_by_name text not null default '',
        issued_at timestamptz not null default now(),
        primary key (intent_id, version)
      );

      create table mandate.back_briefs (
        id text primary key,
        intent_id text not null references mandate.intents (id),
        version integer not null,
        parent_version integer not null,
        by_person text not null,
        by_name text not null default '',
        words text not null,
        concern text not null default '',
        outcome text not null,
        at timestamptz not null default now()
      );
      create index back_briefs_intent on mandate.back_briefs (intent_id, at);

      create table mandate.assessments (
        id text primary key,
        intent_id text not null references mandate.intents (id),
        by_person text not null,
        by_name text not null default '',
        rating text not null,
        note text not null default '',
        at timestamptz not null default now()
      );
      create index assessments_intent on mandate.assessments (intent_id, at);

      create table mandate.entity_bindings (
        intent_id text not null references mandate.intents (id),
        entity_id text not null,
        entity_type text not null,
        label_cache text not null default '',
        role text not null,
        inherited_from text,
        bound_by text not null,
        at timestamptz not null default now(),
        primary key (intent_id, entity_id, role)
      );
      create index entity_bindings_entity on mandate.entity_bindings (entity_id);

      create table mandate.document_bindings (
        intent_id text not null references mandate.intents (id),
        app text not null,
        document_id text not null,
        title_cache text not null default '',
        document_version text,
        inherited_from text,
        bound_by text not null,
        at timestamptz not null default now(),
        primary key (intent_id, app, document_id)
      );

      -- What Mandate tells other apps, sent by the outbox relay once the change commits (docs/domain-events.md).
      create table mandate.outbox (
        id bigint generated always as identity primary key,
        event_id text not null unique default gen_random_uuid()::text,
        topic text not null,
        workspace_id text,
        payload jsonb not null,
        created_at timestamptz not null default now(),
        sent_at timestamptz
      );
      create index outbox_unsent on mandate.outbox (id) where sent_at is null;`,
  },
  {
    // Following the platform and Data Atlas (MB1): holders who leave, retired and merged entities, where it left off.
    id: '002_following',
    sql: `
      alter table mandate.intents add column needs_holder text;
      alter table mandate.intents add column needs_holder_since timestamptz;
      alter table mandate.entity_bindings add column entity_state text not null default 'active' check (entity_state in ('active', 'retired', 'merged'));
      alter table mandate.entity_bindings add column merged_from text;
      create index entity_bindings_merged_from on mandate.entity_bindings (merged_from) where merged_from is not null;
      create table mandate.event_cursor (id integer primary key check (id = 1), seq text not null);`,
  },
  {
    // Reminders on time (ADR 0061): what each was last sent for, so a sweep sends each once.
    id: '003_reminders',
    sql: `
      alter table mandate.intents add column brief_by date;
      alter table mandate.intents add column rhythm text;
      alter table mandate.intents add column reminded_brief_for text;
      alter table mandate.intents add column reminded_rating_for text;
      create index intents_waiting on mandate.intents (brief_by) where life = 'passed';
      create index intents_under_way on mandate.intents (life) where life = 'active';`,
  },
  {
    // An intent's discussion (MB2): kept by the thing it's about, as AUGUR names things (ADR 0028), so it can move to the platform later.
    id: '004_discussion',
    sql: `
      create table mandate.messages (
        id text primary key,
        ref_app text not null,
        ref_type text not null,
        ref_id text not null,
        kind text not null check (kind in ('concern', 'answer', 'note')),
        words text not null,
        answers text references mandate.messages (id),
        by_person text not null,
        by_name text not null default '',
        at timestamptz not null default now()
      );
      create index messages_ref on mandate.messages (ref_app, ref_type, ref_id, at);`,
  },
  {
    // Closing with a choice (MB4): a part let stand alone when the intent above it closed.
    id: '005_stand_alone',
    sql: `
      alter table mandate.intents add column stood_alone_from text;
      alter table mandate.intents add column stood_alone_at timestamptz;`,
  },
];

export const INTENT_COLUMNS = `id, parent_id, root_id, ancestors, workspace_id, floor_principal, floor_kind, floor_name, holder, holder_name, title, life, version, draft,
  briefed_parent_version, main_effort, to_char(by_date, 'YYYY-MM-DD') as by_date, rhythm_days, rating, rating_note, rated_at, created_by, created_by_name,
  passed_by, passed_by_name, passed_at, ended_at, ended_reason, needs_holder, needs_holder_since, created_at, updated_at, to_char(brief_by, 'YYYY-MM-DD') as brief_by, rhythm,
  stood_alone_from, stood_alone_at`;

export type IntentRow = {
  id: string; parent_id: string | null; root_id: string; ancestors: string[]; workspace_id: string; floor_principal: string; floor_kind: Intent['floorKind']; floor_name: string;
  holder: string; holder_name: string; title: string; life: Life; version: number; draft: Statement; briefed_parent_version: number | null; main_effort: boolean;
  by_date: string | null; rhythm_days: number; rating: Rating | null; rating_note: string | null; rated_at: Date | null; created_by: string; created_by_name: string;
  passed_by: string | null; passed_by_name: string | null; passed_at: Date | null; ended_at: Date | null; ended_reason: string | null;
  needs_holder: Wire.NeedsHolder['why'] | null; needs_holder_since: Date | null; created_at: Date; updated_at: Date;
  brief_by: string | null; rhythm: string | null; stood_alone_from: string | null; stood_alone_at: Date | null;
};

const opt = <K extends string, V>(key: K, value: V | null | undefined) => (value === null || value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));
const iso = (d: Date | null) => d?.toISOString();

export const fromIntentRow = (r: IntentRow): Intent => ({
  id: r.id,
  ...opt('parent', r.parent_id),
  root: r.root_id,
  ancestors: r.ancestors,
  workspace: r.workspace_id,
  floor: r.floor_principal,
  floorKind: r.floor_kind,
  floorName: r.floor_name,
  holder: r.holder,
  holderName: r.holder_name,
  title: r.title,
  life: r.life,
  version: r.version,
  draft: { ...EMPTY_STATEMENT, ...r.draft },
  ...opt('briefedParentVersion', r.briefed_parent_version),
  mainEffort: r.main_effort,
  ...opt('byDate', r.by_date),
  rhythmDays: r.rhythm_days,
  ...opt('rating', r.rating),
  ...opt('ratingNote', r.rating_note),
  ...opt('ratedAt', iso(r.rated_at)),
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  ...opt('passedBy', r.passed_by),
  ...opt('passedByName', r.passed_by_name),
  ...opt('passedAt', iso(r.passed_at)),
  ...opt('endedAt', iso(r.ended_at)),
  ...opt('endedReason', r.ended_reason),
  ...(r.needs_holder ? { needsHolder: { why: r.needs_holder, since: (r.needs_holder_since ?? r.updated_at).toISOString() } } : {}),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  ...opt('briefBy', r.brief_by),
  ...opt('rhythm', r.rhythm),
  ...(r.stood_alone_from ? { stoodAlone: { from: r.stood_alone_from, at: (r.stood_alone_at ?? r.updated_at).toISOString() } } : {}),
});

export class PgMandateStore implements MandateStore {
  // A plain field, not a parameter property: `pnpm dev:app` runs this file with Node's type stripping.
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string) {
    const store = new PgMandateStore(steadyPool(new pg.Pool({ connectionString })));
    await store.migrate();
    return store;
  }

  /** A connection pool whose search path is Mandate's schema, for the outbox relay, which names its table plainly. */
  static outboxPool(connectionString: string) {
    return steadyPool(new pg.Pool({ connectionString, max: 2, options: '-c search_path=mandate' }));
  }

  /** Brings the schema up to date. Safe to run from several instances at once (the service kit's runMigrations). */
  async migrate() {
    await runMigrations(this.pool, { schema: 'mandate', migrations });
  }

  async close() {
    await this.pool.end();
  }

  private async select(where: string, values: unknown[]) {
    const { rows } = await this.pool.query<IntentRow>(`select ${INTENT_COLUMNS} from mandate.intents where ${where} order by cardinality(ancestors), created_at, id`, values);
    return rows.map(fromIntentRow);
  }

  async intent(id: string) {
    return (await this.select('id = $1', [id]))[0];
  }
  tree(root: string) {
    return this.select('root_id = $1', [root]);
  }
  onFloor(workspace: string) {
    return this.select('workspace_id = $1', [workspace]);
  }
  heldBy(person: string) {
    return this.select('holder = $1', [`person:${person}`]);
  }
  async intents(ids: readonly string[]) {
    return ids.length ? this.select('id = any($1::text[])', [ids]) : [];
  }

  async search(words: readonly string[], limit: number) {
    if (!words.length) return [];
    const like = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const { rows } = await this.pool.query<IntentRow>(`select ${INTENT_COLUMNS} from mandate.intents where title ilike all($1::text[]) order by updated_at desc limit $2`, [like, limit]);
    return rows.map(fromIntentRow);
  }

  async versions(intent: string) {
    const { rows } = await this.pool.query('select * from mandate.versions where intent_id = $1 order by version desc', [intent]);
    return rows.map((r): Version => ({ intent: r.intent_id, version: r.version, title: r.title, statement: { ...EMPTY_STATEMENT, ...r.statement }, issuedBy: r.issued_by, issuedByName: r.issued_by_name, issuedAt: r.issued_at.toISOString() }));
  }

  async backBriefs(intent: string) {
    const { rows } = await this.pool.query('select * from mandate.back_briefs where intent_id = $1 order by at desc, id', [intent]);
    return rows.map((r): BackBrief => ({ id: r.id, intent: r.intent_id, version: r.version, parentVersion: r.parent_version, by: r.by_person, byName: r.by_name, words: r.words, concern: r.concern, outcome: r.outcome, at: r.at.toISOString() }));
  }

  async assessments(intent: string, limit = 20) {
    const { rows } = await this.pool.query('select * from mandate.assessments where intent_id = $1 order by at desc, id limit $2', [intent, limit]);
    return rows.map((r): Assessment => ({ id: r.id, intent: r.intent_id, by: r.by_person, byName: r.by_name, rating: r.rating, note: r.note, at: r.at.toISOString() }));
  }

  async messages(intent: string) {
    const { rows } = await this.pool.query("select * from mandate.messages where ref_app = 'mandate' and ref_type = 'intent' and ref_id = $1 order by at, id", [intent]);
    return rows.map((r): Message => ({ id: r.id, intent: r.ref_id, kind: r.kind, words: r.words, ...opt('answers', r.answers as string | null), by: r.by_person, byName: r.by_name, at: r.at.toISOString() }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a pg row, typed by the query that read it
  private static entityRow = (r: Record<string, any>): EntityBinding => ({
    intent: r.intent_id,
    entity: { kind: 'entity', id: r.entity_id, type: r.entity_type, label: r.label_cache },
    role: r.role,
    ...opt('inheritedFrom', r.inherited_from as string | null),
    ...(r.entity_state && r.entity_state !== 'active' ? { state: r.entity_state as EntityBinding['state'] } : {}),
    ...opt('mergedFrom', r.merged_from as string | null),
    boundBy: r.bound_by,
    at: r.at.toISOString(),
  });

  async entityBindings(intents: readonly string[]) {
    if (!intents.length) return [];
    const { rows } = await this.pool.query("select * from mandate.entity_bindings where intent_id = any($1::text[]) and entity_state <> 'merged' order by at, entity_id", [intents]);
    return rows.map(PgMandateStore.entityRow);
  }

  async boundTo(entity: string, hidden = false) {
    const { rows } = await this.pool.query(`select * from mandate.entity_bindings where entity_id = $1 ${hidden ? '' : "and entity_state <> 'merged'"} order by at`, [entity]);
    return rows.map(PgMandateStore.entityRow);
  }

  async mergedFrom(entity: string) {
    const { rows } = await this.pool.query('select * from mandate.entity_bindings where merged_from = $1 order by at', [entity]);
    return rows.map(PgMandateStore.entityRow);
  }

  async cursor() {
    const { rows } = await this.pool.query<{ seq: string }>('select seq from mandate.event_cursor where id = 1');
    return rows[0]?.seq;
  }

  async saveCursor(seq: string) {
    await this.pool.query('insert into mandate.event_cursor (id, seq) values (1, $1) on conflict (id) do update set seq = excluded.seq', [seq]);
  }

  async documentBindings(intents: readonly string[]) {
    if (!intents.length) return [];
    const { rows } = await this.pool.query('select * from mandate.document_bindings where intent_id = any($1::text[]) order by at, document_id', [intents]);
    return rows.map(
      (r): DocumentBinding => ({
        intent: r.intent_id,
        document: { app: r.app, id: r.document_id, title: r.title_cache, ...opt('version', r.document_version as string | null) },
        ...opt('inheritedFrom', r.inherited_from as string | null),
        boundBy: r.bound_by,
        at: r.at.toISOString(),
      }),
    );
  }

  async commit(change: Change) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const i of change.intents ?? [])
        await client.query(
          `insert into mandate.intents (id, parent_id, root_id, ancestors, workspace_id, floor_principal, floor_kind, floor_name, holder, holder_name, title, life, version, draft,
             briefed_parent_version, main_effort, by_date, rhythm_days, rating, rating_note, rated_at, created_by, created_by_name, passed_by, passed_by_name, passed_at,
             ended_at, ended_reason, created_at, updated_at, needs_holder, needs_holder_since, brief_by, rhythm, stood_alone_from, stood_alone_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
           on conflict (id) do update set parent_id = excluded.parent_id, root_id = excluded.root_id, ancestors = excluded.ancestors, workspace_id = excluded.workspace_id,
             floor_principal = excluded.floor_principal, floor_kind = excluded.floor_kind, stood_alone_from = excluded.stood_alone_from, stood_alone_at = excluded.stood_alone_at,
             floor_name = excluded.floor_name, needs_holder = excluded.needs_holder, needs_holder_since = excluded.needs_holder_since,
             passed_by = excluded.passed_by, passed_by_name = excluded.passed_by_name, passed_at = excluded.passed_at, holder = excluded.holder, holder_name = excluded.holder_name, title = excluded.title, life = excluded.life,
             version = excluded.version, draft = excluded.draft, briefed_parent_version = excluded.briefed_parent_version, main_effort = excluded.main_effort,
             by_date = excluded.by_date, rhythm_days = excluded.rhythm_days, rating = excluded.rating, rating_note = excluded.rating_note, rated_at = excluded.rated_at,
             ended_at = excluded.ended_at, ended_reason = excluded.ended_reason, updated_at = excluded.updated_at, brief_by = excluded.brief_by, rhythm = excluded.rhythm`,
          [
            i.id, i.parent ?? null, i.root, i.ancestors, i.workspace, i.floor, i.floorKind, i.floorName, i.holder, i.holderName, i.title, i.life, i.version, JSON.stringify(i.draft),
            i.briefedParentVersion ?? null, i.mainEffort, i.byDate ?? null, i.rhythmDays, i.rating ?? null, i.ratingNote ?? null, i.ratedAt ?? null, i.createdBy, i.createdByName,
            i.passedBy ?? null, i.passedByName ?? null, i.passedAt ?? null, i.endedAt ?? null, i.endedReason ?? null, i.createdAt, i.updatedAt,
            i.needsHolder?.why ?? null, i.needsHolder?.since ?? null, i.briefBy ?? null, i.rhythm ?? null, i.stoodAlone?.from ?? null, i.stoodAlone?.at ?? null,
          ],
        );
      for (const v of change.versions ?? []) {
        const { rowCount } = await client.query(
          `insert into mandate.versions (intent_id, version, title, statement, issued_by, issued_by_name, issued_at) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [v.intent, v.version, v.title, JSON.stringify(v.statement), v.issuedBy, v.issuedByName, v.issuedAt],
        );
        if (!rowCount) throw new ConflictError('That version was issued already.');
      }
      for (const b of change.backBriefs ?? [])
        await client.query(
          'insert into mandate.back_briefs (id, intent_id, version, parent_version, by_person, by_name, words, concern, outcome, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [b.id, b.intent, b.version, b.parentVersion, b.by, b.byName, b.words, b.concern, b.outcome, b.at],
        );
      for (const a of change.assessments ?? [])
        await client.query('insert into mandate.assessments (id, intent_id, by_person, by_name, rating, note, at) values ($1,$2,$3,$4,$5,$6,$7)', [a.id, a.intent, a.by, a.byName, a.rating, a.note, a.at]);
      for (const m of change.messages ?? [])
        await client.query(
          "insert into mandate.messages (id, ref_app, ref_type, ref_id, kind, words, answers, by_person, by_name, at) values ($1, 'mandate', 'intent', $2, $3, $4, $5, $6, $7, $8)",
          [m.id, m.intent, m.kind, m.words, m.answers ?? null, m.by, m.byName, m.at],
        );
      for (const u of change.unbindEntities ?? [])
        await client.query('delete from mandate.entity_bindings where intent_id = $1 and entity_id = $2 and role = $3', [u.intent, u.entity, u.role]);
      for (const u of change.unbindDocuments ?? [])
        await client.query('delete from mandate.document_bindings where intent_id = $1 and app = $2 and document_id = $3', [u.intent, u.app, u.id]);
      for (const b of change.entityBindings ?? [])
        await client.query(
          `insert into mandate.entity_bindings (intent_id, entity_id, entity_type, label_cache, role, inherited_from, bound_by, at, entity_state, merged_from) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (intent_id, entity_id, role) do update set entity_type = excluded.entity_type, label_cache = excluded.label_cache`,
          [b.intent, b.entity.id, b.entity.type, b.entity.label, b.role, b.inheritedFrom ?? null, b.boundBy, b.at, b.state ?? 'active', b.mergedFrom ?? null],
        );
      for (const e of change.entityStates ?? [])
        await client.query("update mandate.entity_bindings set entity_state = $2 where entity_id = $1 and entity_state <> 'merged'", [e.entity, e.state]);
      for (const u of change.bindingStates ?? [])
        await client.query('update mandate.entity_bindings set entity_state = $4 where intent_id = $1 and entity_id = $2 and role = $3', [u.intent, u.entity, u.role, u.state]);
      for (const b of change.documentBindings ?? [])
        await client.query(
          `insert into mandate.document_bindings (intent_id, app, document_id, title_cache, document_version, inherited_from, bound_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (intent_id, app, document_id) do update set title_cache = excluded.title_cache, document_version = excluded.document_version`,
          [b.intent, b.document.app, b.document.id, b.document.title, b.document.version ?? null, b.inheritedFrom ?? null, b.boundBy, b.at],
        );
      for (const e of change.events ?? [])
        await client.query('insert into mandate.outbox (topic, workspace_id, payload) values ($1, $2, $3)', [e.topic, e.workspace, JSON.stringify(e.payload)]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}
