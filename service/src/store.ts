import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Mandate's records. An intent is one row that refers to its parent; what
 * kind of intent it is (an operation, a team's part, a person's task) is never
 * stored, only read from where it sits. Statements are versioned and a version
 * is never changed once issued. See apps/mandate/README.md.
 */

/** Where an intent is in its life. Separate from how its holder judges it is going (`Rating`). */
export const LIVES = ['draft', 'passed', 'active', 'achieved', 'superseded', 'withdrawn'] as const;
export type Life = (typeof LIVES)[number];
/** Lives that are over: kept, shown under "Closed", never changed again. */
export const ENDED: readonly Life[] = ['achieved', 'superseded', 'withdrawn'];

export const RATINGS = ['on_track', 'at_risk', 'blocked', 'achieved'] as const;
export type Rating = (typeof RATINGS)[number];

/** The roles an entity plays in an intent, agreed with Data Atlas. An open string; these four are documented. */
export const ROLES = ['subject', 'resource', 'area', 'related'] as const;

/**
 * An intent in words, in the shape allied orders use: a one-line mission
 * (who, what, when, where), the purpose it serves, the end state that means
 * it's done, the key tasks, what must be done (constraints), what must not be
 * done (restraints), and what the holder may decide for themselves (freedoms).
 */
export interface Statement {
  mission: string;
  purpose: string;
  endState: string;
  keyTasks: string[];
  constraints: string;
  restraints: string;
  freedoms: string;
}

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
  floorKind: 'personal' | 'team' | 'org';
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
  /** How often its holder is asked for an assessment, in days. */
  rhythmDays: number;
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

export interface BackBrief {
  id: string;
  intent: string;
  /** The version of the intent it answers. */
  version: number;
  /** The parent's version at the time. */
  parentVersion: number;
  by: string;
  byName: string;
  words: string;
  concern: string;
  outcome: 'accepted' | 'concern';
  at: string;
}

export interface Assessment {
  id: string;
  intent: string;
  by: string;
  byName: string;
  rating: Rating;
  note: string;
  at: string;
}

/** An entity from Data Atlas, as Mandate keeps a reference to it. The label is a cached name and may be stale. */
export interface EntityRef {
  kind: 'entity';
  id: string;
  type: string;
  label: string;
}

/** A document, as apps pass them (the SDK's DocumentRef). */
export interface DocumentRef {
  app: string;
  id: string;
  title: string;
  version?: string;
}

export interface EntityBinding {
  intent: string;
  entity: EntityRef;
  role: string;
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
  entityBindings?: EntityBinding[];
  documentBindings?: DocumentBinding[];
  unbindEntities?: { intent: string; entity: string; role: string }[];
  unbindDocuments?: { intent: string; app: string; id: string }[];
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
  entityBindings(intents: readonly string[]): Promise<EntityBinding[]>;
  documentBindings(intents: readonly string[]): Promise<DocumentBinding[]>;
  /** The bindings of one entity: what Data Atlas shows as "used by". */
  boundTo(entity: string): Promise<EntityBinding[]>;
  commit(change: Change): Promise<void>;
}

export const newId = () => randomUUID();

const byTree = (a: Intent, b: Intent) => a.ancestors.length - b.ancestors.length || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Without Postgres, as under `pnpm dev:app`: forgets everything on restart. */
export class MemoryMandateStore implements MandateStore {
  readonly rows = new Map<string, Intent>();
  readonly versionRows: Version[] = [];
  readonly briefRows: BackBrief[] = [];
  readonly assessmentRows: Assessment[] = [];
  entityRows: EntityBinding[] = [];
  documentRows: DocumentBinding[] = [];
  readonly outbox: OutboxEvent[] = [];

  async intent(id: string) {
    const row = this.rows.get(id);
    return row && structuredClone(row);
  }
  async tree(root: string) {
    return [...this.rows.values()].filter((i) => i.root === root).sort(byTree).map((i) => structuredClone(i));
  }
  async onFloor(workspace: string) {
    return [...this.rows.values()].filter((i) => i.workspace === workspace).sort(byTree).map((i) => structuredClone(i));
  }
  async heldBy(person: string) {
    return [...this.rows.values()].filter((i) => i.holder === `person:${person}`).sort(byTree).map((i) => structuredClone(i));
  }
  async intents(ids: readonly string[]) {
    return ids.flatMap((id) => (this.rows.has(id) ? [structuredClone(this.rows.get(id)!)] : []));
  }
  async search(words: readonly string[], limit: number) {
    if (!words.length) return [];
    return [...this.rows.values()]
      .filter((i) => words.every((w) => i.title.toLowerCase().includes(w.toLowerCase())))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((i) => structuredClone(i));
  }
  async versions(intent: string) {
    return this.versionRows.filter((v) => v.intent === intent).sort((a, b) => b.version - a.version);
  }
  async backBriefs(intent: string) {
    return this.briefRows.filter((b) => b.intent === intent).reverse();
  }
  async assessments(intent: string, limit = 20) {
    return this.assessmentRows.filter((a) => a.intent === intent).reverse().slice(0, limit);
  }
  async entityBindings(intents: readonly string[]) {
    return this.entityRows.filter((b) => intents.includes(b.intent));
  }
  async documentBindings(intents: readonly string[]) {
    return this.documentRows.filter((b) => intents.includes(b.intent));
  }
  async boundTo(entity: string) {
    return this.entityRows.filter((b) => b.entity.id === entity);
  }
  async commit(change: Change) {
    for (const v of change.versions ?? []) if (this.versionRows.some((r) => r.intent === v.intent && r.version === v.version)) throw new ConflictError('That version was issued already.');
    for (const i of change.intents ?? []) this.rows.set(i.id, structuredClone(i));
    this.versionRows.push(...(change.versions ?? []));
    this.briefRows.push(...(change.backBriefs ?? []));
    this.assessmentRows.push(...(change.assessments ?? []));
    for (const u of change.unbindEntities ?? []) this.entityRows = this.entityRows.filter((b) => !(b.intent === u.intent && b.entity.id === u.entity && b.role === u.role));
    for (const u of change.unbindDocuments ?? []) this.documentRows = this.documentRows.filter((b) => !(b.intent === u.intent && b.document.app === u.app && b.document.id === u.id));
    for (const b of change.entityBindings ?? []) {
      this.entityRows = this.entityRows.filter((r) => !(r.intent === b.intent && r.entity.id === b.entity.id && r.role === b.role));
      this.entityRows.push(b);
    }
    for (const b of change.documentBindings ?? []) {
      this.documentRows = this.documentRows.filter((r) => !(r.intent === b.intent && r.document.app === b.document.app && r.document.id === b.document.id));
      this.documentRows.push(b);
    }
    this.outbox.push(...(change.events ?? []));
  }
}

/** Mandate's schema, oldest first. Once released, a migration never changes (scripts/check-migrations.mjs). */
export const migrations: { id: string; sql: string }[] = [
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
];

const INTENT_COLUMNS = `id, parent_id, root_id, ancestors, workspace_id, floor_principal, floor_kind, floor_name, holder, holder_name, title, life, version, draft,
  briefed_parent_version, main_effort, to_char(by_date, 'YYYY-MM-DD') as by_date, rhythm_days, rating, rating_note, rated_at, created_by, created_by_name,
  passed_by, passed_by_name, passed_at, ended_at, ended_reason, created_at, updated_at`;

type IntentRow = {
  id: string; parent_id: string | null; root_id: string; ancestors: string[]; workspace_id: string; floor_principal: string; floor_kind: Intent['floorKind']; floor_name: string;
  holder: string; holder_name: string; title: string; life: Life; version: number; draft: Statement; briefed_parent_version: number | null; main_effort: boolean;
  by_date: string | null; rhythm_days: number; rating: Rating | null; rating_note: string | null; rated_at: Date | null; created_by: string; created_by_name: string;
  passed_by: string | null; passed_by_name: string | null; passed_at: Date | null; ended_at: Date | null; ended_reason: string | null; created_at: Date; updated_at: Date;
};

const opt = <K extends string, V>(key: K, value: V | null | undefined) => (value === null || value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));
const iso = (d: Date | null) => d?.toISOString();

const fromIntentRow = (r: IntentRow): Intent => ({
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
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export class PgMandateStore implements MandateStore {
  // A plain field, not a parameter property: `pnpm dev:app` runs this file with Node's type stripping.
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string) {
    const store = new PgMandateStore(new pg.Pool({ connectionString }));
    await store.migrate();
    return store;
  }

  /** A connection pool whose search path is Mandate's schema, for the outbox relay, which names its table plainly. */
  static outboxPool(connectionString: string) {
    return new pg.Pool({ connectionString, max: 2, options: '-c search_path=mandate' });
  }

  /** Brings the schema up to date. Safe to run from several instances at once. */
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('mandate.migrate'))");
      // On a server the platform makes the schema for Mandate's login, which may not create schemas itself.
      const { rowCount } = await client.query("select 1 from pg_namespace where nspname = 'mandate'");
      if (!rowCount) await client.query('create schema mandate');
      await client.query('create table if not exists mandate.migrations (id text primary key, applied_at timestamptz not null default now())');
      const { rows } = await client.query<{ id: string }>('select id from mandate.migrations');
      const applied = new Set(rows.map((r) => r.id));
      for (const m of migrations.filter((m) => !applied.has(m.id))) {
        await client.query(m.sql);
        await client.query('insert into mandate.migrations (id) values ($1)', [m.id]);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
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

  private static entityRow = (r: Record<string, any>): EntityBinding => ({
    intent: r.intent_id,
    entity: { kind: 'entity', id: r.entity_id, type: r.entity_type, label: r.label_cache },
    role: r.role,
    ...opt('inheritedFrom', r.inherited_from as string | null),
    boundBy: r.bound_by,
    at: r.at.toISOString(),
  });

  async entityBindings(intents: readonly string[]) {
    if (!intents.length) return [];
    const { rows } = await this.pool.query('select * from mandate.entity_bindings where intent_id = any($1::text[]) order by at, entity_id', [intents]);
    return rows.map(PgMandateStore.entityRow);
  }

  async boundTo(entity: string) {
    const { rows } = await this.pool.query('select * from mandate.entity_bindings where entity_id = $1 order by at', [entity]);
    return rows.map(PgMandateStore.entityRow);
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
             ended_at, ended_reason, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
           on conflict (id) do update set holder = excluded.holder, holder_name = excluded.holder_name, title = excluded.title, life = excluded.life,
             version = excluded.version, draft = excluded.draft, briefed_parent_version = excluded.briefed_parent_version, main_effort = excluded.main_effort,
             by_date = excluded.by_date, rhythm_days = excluded.rhythm_days, rating = excluded.rating, rating_note = excluded.rating_note, rated_at = excluded.rated_at,
             ended_at = excluded.ended_at, ended_reason = excluded.ended_reason, updated_at = excluded.updated_at`,
          [
            i.id, i.parent ?? null, i.root, i.ancestors, i.workspace, i.floor, i.floorKind, i.floorName, i.holder, i.holderName, i.title, i.life, i.version, JSON.stringify(i.draft),
            i.briefedParentVersion ?? null, i.mainEffort, i.byDate ?? null, i.rhythmDays, i.rating ?? null, i.ratingNote ?? null, i.ratedAt ?? null, i.createdBy, i.createdByName,
            i.passedBy ?? null, i.passedByName ?? null, i.passedAt ?? null, i.endedAt ?? null, i.endedReason ?? null, i.createdAt, i.updatedAt,
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
      for (const u of change.unbindEntities ?? [])
        await client.query('delete from mandate.entity_bindings where intent_id = $1 and entity_id = $2 and role = $3', [u.intent, u.entity, u.role]);
      for (const u of change.unbindDocuments ?? [])
        await client.query('delete from mandate.document_bindings where intent_id = $1 and app = $2 and document_id = $3', [u.intent, u.app, u.id]);
      for (const b of change.entityBindings ?? [])
        await client.query(
          `insert into mandate.entity_bindings (intent_id, entity_id, entity_type, label_cache, role, inherited_from, bound_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (intent_id, entity_id, role) do update set entity_type = excluded.entity_type, label_cache = excluded.label_cache`,
          [b.intent, b.entity.id, b.entity.type, b.entity.label, b.role, b.inheritedFrom ?? null, b.boundBy, b.at],
        );
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
