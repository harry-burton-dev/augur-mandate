import type { DocumentRef, EntityRef, MountContext } from '@augur/mfe-sdk';
import type {
  AssessBody,
  BackBriefBody,
  Detail,
  EditBody,
  Floor,
  HomeGlance,
  PassBody,
  Problem,
  Rating,
  SearchResults,
  Summary,
  Targets,
  Yours,
} from '../../service/src/api-types.js';

export type { EntityRef };
// The wire types are written once, in the service's api-types.ts, and shared with it.
export type {
  Assessment,
  BackBrief,
  Branch,
  Detail,
  Floor,
  FloorItem,
  FloorKind,
  HomeGlance,
  Life,
  Rating,
  Rights,
  Statement,
  Summary,
  Target,
  Yours,
} from '../../service/src/api-types.js';

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
      const problem = (await res.json().catch(() => ({}))) as Partial<Problem>;
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
    return this.call<SearchResults>('GET', `/search?q=${encodeURIComponent(q)}`);
  }
  intent(id: string) {
    return this.call<Detail>('GET', `/intents/${encodeURIComponent(id)}`);
  }
  create(title: string, floorName: string) {
    return this.call<Summary>('POST', '/intents', { title, floorName });
  }
  edit(id: string, change: EditBody) {
    return this.call<Detail>('PATCH', `/intents/${encodeURIComponent(id)}`, change);
  }
  issue(id: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/issue`);
  }
  targets(id: string, q: string) {
    return this.call<Targets>('GET', `/intents/${encodeURIComponent(id)}/targets?q=${encodeURIComponent(q)}`);
  }
  pass(id: string, part: PassBody) {
    return this.call<Summary>('POST', `/intents/${encodeURIComponent(id)}/pass`, part);
  }
  backBrief(id: string, brief: BackBriefBody) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/back-brief`, brief);
  }
  assess(id: string, rating: Rating, note: string) {
    return this.call<Detail>('POST', `/intents/${encodeURIComponent(id)}/assess`, { rating, note } satisfies AssessBody);
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
