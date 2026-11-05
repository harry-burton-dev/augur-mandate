import pg from 'pg';
import { steadyPool } from '@augur/service-kit';
import { fromIntentRow, INTENT_COLUMNS, type Intent, type IntentRow, type MemoryMandateStore } from '../store.ts';

/** Which reminder a row records: the back-brief's, or the assessment's. */
export type Reminder = 'brief' | 'rating';

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
  /** What each intent was last reminded for, of those given. */
  reminded(what: Reminder, intents: readonly string[]): Promise<Map<string, string>>;
  /** Intents reminded for something starting with `prefix`: the ones whose reminder may need taking back. */
  remindedWith(what: Reminder, prefix: string): Promise<{ intent: Intent; value: string }[]>;
  /** Records `value` unless it is already recorded. True when this call changed it: the reminder is this sweep's to send. */
  claim(what: Reminder, intent: string, value: string): Promise<boolean>;
  /** Puts back what was recorded before a claim whose reminder couldn't be sent, so the next sweep tries again. */
  release(what: Reminder, intent: string, value: string, previous: string | undefined): Promise<void>;
}

const COLUMN: Record<Reminder, string> = { brief: 'reminded_brief_for', rating: 'reminded_rating_for' };

export class PgReminderStore implements ReminderStore {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Mandate's store makes the columns (003_reminders); this only reads and records them. */
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

/** Beside the in-memory store, as under `pnpm dev:app` and in tests. */
export class MemoryReminderStore implements ReminderStore {
  readonly values: Record<Reminder, Map<string, string>> = { brief: new Map(), rating: new Map() };
  private readonly store: MemoryMandateStore;

  constructor(store: MemoryMandateStore) {
    this.store = store;
  }

  private all() {
    return [...this.store.rows.values()].map((i) => structuredClone(i)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async waitingForBriefs(through: string) {
    return this.all().filter((i) => i.life === 'passed' && i.briefBy && i.briefBy <= through);
  }
  async underWay(before: Date) {
    return this.all().filter((i) => i.life === 'active' && Date.parse(i.ratedAt ?? i.passedAt ?? i.createdAt) < before.getTime());
  }
  async reminded(what: Reminder, intents: readonly string[]) {
    return new Map(intents.flatMap((id) => (this.values[what].has(id) ? [[id, this.values[what].get(id)!] as const] : [])));
  }
  async remindedWith(what: Reminder, prefix: string) {
    return this.all().flatMap((intent) => {
      const value = this.values[what].get(intent.id);
      return value?.startsWith(prefix) ? [{ intent, value }] : [];
    });
  }
  async claim(what: Reminder, intent: string, value: string) {
    if (!this.store.rows.has(intent) || this.values[what].get(intent) === value) return false;
    this.values[what].set(intent, value);
    return true;
  }
  async release(what: Reminder, intent: string, value: string, previous: string | undefined) {
    if (this.values[what].get(intent) !== value) return;
    if (previous === undefined) this.values[what].delete(intent);
    else this.values[what].set(intent, previous);
  }
}
