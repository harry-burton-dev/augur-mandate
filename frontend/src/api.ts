import type { DocumentRef, MountContext } from '@augur/mfe-sdk';

export type Life = 'draft' | 'passed' | 'active' | 'achieved' | 'superseded' | 'withdrawn';
export type Rating = 'on_track' | 'at_risk' | 'blocked' | 'achieved';
export type FloorKind = 'personal' | 'team' | 'org';

/** An intent in words, as allied orders put it. */
export interface Statement {
  mission: string;
  purpose: string;
  endState: string;
  keyTasks: string[];
  constraints: string;
  restraints: string;
  freedoms: string;
}

/** An intent as a summary shows it. `sight` says whether the person may open it. */
export interface Summary {
  id: string;
  parent?: string;
  root: string;
  title: string;
  floorName: string;
  floorKind: FloorKind;
  /** `person:<id>`, or `floor`: the leads of its floor hold it. */
  holder: string;
  holderName: string;
  life: Life;
  version: number;
  mainEffort: boolean;
  byDate?: string;
  rating?: Rating;
  ratingNote?: string;
  ratedAt?: string;
  sight: 'full' | 'summary';
  /** The intent it's part of, in lists. */
  partOf?: string;
}

export type Branch = Summary & { below: Branch[] };

export interface FloorItem extends Summary {
  counts: { parts: number; atRisk: number; blocked: number };
}

export interface Floor {
  intents: FloorItem[];
  drafts: FloorItem[];
  closed: FloorItem[];
  can: { create: boolean };
}

export interface Yours {
  passed: Summary[];
  recheck: Summary[];
  due: Summary[];
  holding: Summary[];
}

export interface HomeGlance {
  waiting: Summary[];
  due: number;
  holding: number;
  floor: { active: number; atRisk: number; blocked: number };
}

export interface Rights {
  edit: boolean;
  pass: boolean;
  backBrief: boolean;
  assess: boolean;
  bind: boolean;
  achieve: boolean;
  withdraw: boolean;
  mainEffort: boolean;
}

/** An entity from Data Atlas, as the shared reference has it. */
export interface EntityRef {
  kind: 'entity';
  id: string;
  type: string;
  label: string;
}

export interface BackBrief {
  id: string;
  version: number;
  parentVersion: number;
  byName: string;
  words: string;
  concern: string;
  outcome: 'accepted' | 'concern';
  at: string;
}

export interface Assessment {
  id: string;
  byName: string;
  rating: Rating;
  note: string;
  at: string;
}

/** Everything one intent's page shows. */
export interface Detail {
  intent: Summary;
  statement: Statement;
  /** The statement as its holder is writing it, for them alone. */
  draft?: Statement;
  issued?: { version: number; by: string; at: string };
  versions: { version: number; title: string; by: string; at: string }[];
  passed?: { by: string; at: string };
  rhythmDays: number;
  ended?: { at: string; reason: string };
  lineOfSight: (Summary & { mission: string; purpose: string; endState: string })[];
  below: Branch[];
  backBriefs: BackBrief[];
  assessments: Assessment[];
  entities: { entity: EntityRef; role: string; from?: string; at: string }[];
  documents: { document: DocumentRef; from?: string; at: string }[];
  recheck: boolean;
  assessmentDue: boolean;
  can: Rights;
}

export interface Target {
  to: string;
  name: string;
  within?: string[];
  you?: boolean;
  email?: string;
}

/** An intent, as apps pass them between them (`aim.pick` answers one). */
export interface IntentRef {
  kind: 'intent';
  app: 'mandate';
  id: string;
  title: string;
}

/** Where Mandate is: a floor's list, what you hold, or one intent. */
export type Place = { view: 'floor' } | { view: 'yours' } | { view: 'intent'; id: string };

export const placeFor = (path: string): Place => {
  const [, first, second] = path.split('/');
  if (first === 'yours') return { view: 'yours' };
  if (first === 'intents' && second) return { view: 'intent', id: decodeURIComponent(second) };
  return { view: 'floor' };
};

export const pathFor = (place: Place) => (place.view === 'yours' ? '/yours' : place.view === 'intent' ? `/intents/${encodeURIComponent(place.id)}` : '/');

/** Something Mandate's service refused, in words people can act on. */
export class MandateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const RATING_WORDS: Record<Rating, string> = { on_track: 'On track', at_risk: 'At risk', blocked: 'Blocked', achieved: 'Achieved' };
export const ROLE_WORDS: Record<string, string> = { subject: 'Subject', resource: 'Resource', area: 'Area', related: 'Related' };

export class MandateApi {
  constructor(private readonly fetchOnFloor: MountContext['fetch']) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchOnFloor(`/api/mandate/v1${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new MandateError(res.status >= 500 || !problem.message ? 'Mandate isn’t answering. Try again in a moment.' : problem.message, res.status, problem.error);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  floor() {
    return this.call<Floor>('GET', '/floor');
  }
  yours() {
    return this.call<Yours>('GET', '/me');
  }
  home() {
    return this.call<HomeGlance>('GET', '/home');
  }
  /** Intents the person can read, by the words of their title. */
  search(q: string) {
    return this.call<{ results: { id: string; title: string; detail: string }[] }>('GET', `/search?q=${encodeURIComponent(q)}`);
  }
  intent(id: string) {
    return this.call<Detail>('GET', `/intents/${encodeURIComponent(id)}`);
  }
  create(title: string, floorName: string) {
    return this.call<Summary>('POST', '/intents', { title, floorName });
  }
  edit(id: string, change: { title?: string; statement?: Partial<Statement>; byDate?: string | null; rhythmDays?: number }) {
    return this.call<Detail>('PATCH', `/intents/${encodeURIComponent(id)}`, change);
  }
  issue(id: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/issue`);
  }
  targets(id: string, q: string) {
    return this.call<{ teams: Target[]; people: Target[] }>('GET', `/intents/${encodeURIComponent(id)}/targets?q=${encodeURIComponent(q)}`);
  }
  pass(id: string, part: { to: string; title: string; purpose?: string; byDate?: string; carry?: { entities?: string[]; documents?: string[] } }) {
    return this.call<Summary>('POST', `/intents/${encodeURIComponent(id)}/pass`, part);
  }
  backBrief(id: string, brief: { words: string; concern?: string; outcome: 'accepted' | 'concern' }) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/back-brief`, brief);
  }
  assess(id: string, rating: Rating, note: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/assess`, { rating, note });
  }
  achieve(id: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/achieve`);
  }
  withdraw(id: string, reason: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/withdraw`, { reason });
  }
  mainEffort(id: string, on: boolean) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/main-effort`, { on });
  }
  bindEntity(id: string, entity: EntityRef, role: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/entities`, { entity, role });
  }
  unbindEntity(id: string, entity: string, role: string) {
    return this.call<Detail>('DELETE', `/intents/${encodeURIComponent(id)}/entities/${encodeURIComponent(entity)}?role=${encodeURIComponent(role)}`);
  }
  addDocument(id: string, document: DocumentRef) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/documents`, { document });
  }
  removeDocument(id: string, document: DocumentRef) {
    return this.call<Detail>('DELETE', `/intents/${encodeURIComponent(id)}/documents/${encodeURIComponent(document.app)}/${encodeURIComponent(document.id)}`);
  }
}
