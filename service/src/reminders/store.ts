import pg from 'pg';
import { steadyPool } from '@augur/service-kit';
import { fromIntentRow, INTENT_COLUMNS, type Intent, type IntentRow } from '../store.ts';

/** A concern still waiting for its answer, with the part it's about and the intent above that. */
export interface OpenConcern {
  intent: Intent;
  parent?: Intent;
  concern: { id: string; byName: string; at: string };
}

/** Which reminder a row records: the back-brief's, the assessment's, or an unanswered concern's. */
export type Reminder = 'brief' | 'rating' | 'concern';

/**
 * What the reminder sweep reads and records (ADR 0061). Each intent keeps what it was last reminded
 * for (`reminded_brief_for`, `reminded_rating_for`), and a sweep claims a reminder by changing it,
 * so two instances, or a sweep run again after a restart, send nothing twice.
 */
export interface ReminderStore {
  /** Parts still waiting for their back-brief, due on or before `through` (YYYY-MM-DD). */
  waitingForBriefs(through: string): Promise<Intent[]>;
  /** Intents under way whose last assessment (or, without one, their passing or making) was before `before`. */
  underWay(before: Date): Promise<Intent[]>;
  /** Parts not yet ended whose latest concern has no answer after it. */
  openConcerns(): Promise<OpenConcern[]>;
  /** What each intent was last reminded for, of those given. */
  reminded(what: Reminder, intents: readonly string[]): Promise<Map<string, string>>;
  /** Intents reminded for something starting with `prefix`: the ones whose reminder may need taking back. */
  remindedWith(what: Reminder, prefix: string): Promise<{ intent: Intent; value: string }[]>;
  /** Records `value` unless it is already recorded. True when this call changed it: the reminder is this sweep's to send. */
  claim(what: Reminder, intent: string, value: string): Promise<boolean>;
  /** Puts back what was recorded before a claim whose reminder couldn't be sent, so the next sweep tries again. */
  release(what: Reminder, intent: string, value: string, previous: string | undefined): Promise<void>;
}

const COLUMN: Record<Reminder, string> = { brief: 'reminded_brief_for', rating: 'reminded_rating_for', concern: 'reminded_concern_for' };

export class PgReminderStore implements ReminderStore {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Mandate's store makes the columns (003_reminders, 006_concern_reminders); this only reads and records them. */
  static connect(connectionString: string) {
    return new PgReminderStore(steadyPool(new pg.Pool({ connectionString, max: 2 })));
  }

  async waitingForBriefs(through: string) {
    const { rows } = await this.pool.query<IntentRow>(`select ${INTENT_COLUMNS} from mandate.intents where life = 'passed' and brief_by <= $1::date order by brief_by, id`, [through]);
    return rows.map(fromIntentRow);
  }

  async underWay(before: Date) {
    const { rows } = await this.pool.query<IntentRow>(
      `select ${INTENT_COLUMNS} from mandate.intents where life = 'active' and coalesce(rated_at, passed_at, created_at) < $1 order by id`,
      [before],
    );
    return rows.map(fromIntentRow);
  }

  async openConcerns() {
    const { rows } = await this.pool.query<IntentRow & { concern_id: string; concern_by: string; concern_at: Date }>(
      `with latest as (
         select distinct on (ref_id) ref_id as said_on, id as concern_id, kind as said, by_name as concern_by, at as concern_at from mandate.messages
         where ref_app = 'mandate' and ref_type = 'intent' and kind in ('concern', 'answer')
         order by ref_id, at desc, id desc
       )
       select ${INTENT_COLUMNS}, concern_id, concern_by, concern_at
       from latest join mandate.intents on id = said_on
       where said = 'concern' and life in ('passed', 'active') order by id`,
    );
    const parents = await this.intents([...new Set(rows.flatMap((r) => (r.parent_id ? [r.parent_id] : [])))]);
    return rows.map((r): OpenConcern => {
      const intent = fromIntentRow(r);
      const parent = intent.parent ? parents.get(intent.parent) : undefined;
      return { intent, ...(parent ? { parent } : {}), concern: { id: r.concern_id, byName: r.concern_by, at: r.concern_at.toISOString() } };
    });
  }

  private async intents(ids: readonly string[]) {
    if (!ids.length) return new Map<string, Intent>();
    const { rows } = await this.pool.query<IntentRow>(`select ${INTENT_COLUMNS} from mandate.intents where id = any($1::text[])`, [ids]);
    return new Map(rows.map((r) => [r.id, fromIntentRow(r)]));
  }

  async reminded(what: Reminder, intents: readonly string[]) {
    if (!intents.length) return new Map<string, string>();
    const { rows } = await this.pool.query<{ id: string; value: string }>(`select id, ${COLUMN[what]} as value from mandate.intents where id = any($1::text[]) and ${COLUMN[what]} is not null`, [intents]);
    return new Map(rows.map((r) => [r.id, r.value]));
  }

  async remindedWith(what: Reminder, prefix: string) {
    const { rows } = await this.pool.query<IntentRow & { value: string }>(
      `select ${INTENT_COLUMNS}, ${COLUMN[what]} as value from mandate.intents where ${COLUMN[what]} like $1 order by id`,
      [`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
    );
    return rows.map((r) => ({ intent: fromIntentRow(r), value: r.value }));
  }

  async claim(what: Reminder, intent: string, value: string) {
    const { rowCount } = await this.pool.query(`update mandate.intents set ${COLUMN[what]} = $2 where id = $1 and ${COLUMN[what]} is distinct from $2`, [intent, value]);
    return rowCount === 1;
  }

  async release(what: Reminder, intent: string, value: string, previous: string | undefined) {
    await this.pool.query(`update mandate.intents set ${COLUMN[what]} = $3 where id = $1 and ${COLUMN[what]} = $2`, [intent, value, previous ?? null]);
  }

  async close() {
    await this.pool.end();
  }
}
