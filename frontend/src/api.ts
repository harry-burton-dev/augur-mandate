import { createAppClient, type AppClient, type AppFetcher } from '@augur/app-kit';
import type { DocumentRef, EntityRef } from '@augur/mfe-sdk';
import manifest from '../../manifest.json';
import type { EditBody, MandatePaths, PassBody, BackBriefBody, Rating } from '../../service/src/api-types.js';

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

export const RATING_WORDS: Record<Rating, string> = { on_track: 'On track', at_risk: 'At risk', blocked: 'Blocked', achieved: 'Achieved' };
export const ROLE_WORDS: Record<string, string> = { subject: 'Subject', resource: 'Resource', area: 'Area', related: 'Related' };

/** Where the gateway sends Mandate's calls: its own service, at its manifest id. */
export const API = `/api/${manifest.id}/v1`;

/**
 * Mandate's service, through the gateway: each call goes through `ctx.fetch`, so it carries the
 * person's token and the floor, is checked against `MandatePaths`, and fails with an AppError
 * whose message people can act on.
 */
export class MandateApi {
  private readonly client: AppClient<MandatePaths>;
  constructor(ctx: AppFetcher) {
    this.client = createAppClient<MandatePaths>(ctx, { base: API, appName: manifest.name });
  }

  floor(signal?: AbortSignal) {
    return this.client.get('/floor', { signal });
  }
  yours(signal?: AbortSignal) {
    return this.client.get('/me', { signal });
  }
  home(signal?: AbortSignal) {
    return this.client.get('/home', { signal });
  }
  /** Intents the person can read, by the words of their title. */
  search(q: string) {
    return this.client.get('/search', { query: { q } });
  }
  intent(id: string, signal?: AbortSignal) {
    return this.client.get('/intents/{id}', { params: { id }, signal });
  }
  create(title: string, floorName: string) {
    return this.client.post('/intents', { body: { title, floorName } });
  }
  edit(id: string, change: EditBody) {
    return this.client.patch('/intents/{id}', { params: { id }, body: change });
  }
  issue(id: string) {
    return this.client.post('/intents/{id}/issue', { params: { id } });
  }
  targets(id: string, q: string) {
    return this.client.get('/intents/{id}/targets', { params: { id }, query: { q } });
  }
  pass(id: string, part: PassBody) {
    return this.client.post('/intents/{id}/pass', { params: { id }, body: part });
  }
  backBrief(id: string, brief: BackBriefBody) {
    return this.client.post('/intents/{id}/back-brief', { params: { id }, body: brief });
  }
  assess(id: string, rating: Rating, note: string) {
    return this.client.post('/intents/{id}/assess', { params: { id }, body: { rating, note } });
  }
  achieve(id: string) {
    return this.client.post('/intents/{id}/achieve', { params: { id } });
  }
  withdraw(id: string, reason: string) {
    return this.client.post('/intents/{id}/withdraw', { params: { id }, body: { reason } });
  }
  mainEffort(id: string, on: boolean) {
    return this.client.post('/intents/{id}/main-effort', { params: { id }, body: { on } });
  }
  bindEntity(id: string, entity: EntityRef, role: string) {
    return this.client.post('/intents/{id}/entities', { params: { id }, body: { entity, role } });
  }
  unbindEntity(id: string, entity: string, role: string) {
    return this.client.delete('/intents/{id}/entities/{entity}', { params: { id, entity }, query: { role } });
  }
  addDocument(id: string, document: DocumentRef) {
    return this.client.post('/intents/{id}/documents', { params: { id }, body: { document } });
  }
  removeDocument(id: string, document: DocumentRef) {
    return this.client.delete('/intents/{id}/documents/{app}/{doc}', { params: { id, app: document.app, doc: document.id } });
  }
}
