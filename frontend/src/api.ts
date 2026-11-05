import { AppError, createAppClient, type AppClient, type AppFetcher } from '@augur/app-kit';
import type { DocumentRef, EntityRef } from '@augur/mfe-sdk';
import manifest from '../../manifest.json';
import type { CloseChoice, EditBody, MandatePaths, MessageKind, PassBody, BackBriefBody, Rating, RevisePartBody } from '../../service/src/api-types.js';

export type { EntityRef };
// The wire types are written once, in the service's api-types.ts, and shared with it.
export type {
  Assessment,
  BackBrief,
  Branch,
  CloseChoice,
  Detail,
  Floor,
  FloorItem,
  FloorKind,
  HomeGlance,
  Life,
  Message,
  MessageKind,
  NeedsHolder,
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
 * A refusal in the service's own sentence. The service kit's problem body has a code in `reason` and the
 * sentence in `detail` (and `message`), but Quill up to 0.7 makes `reason` the message (augur-kit #31);
 * until a fixed kit is served, Mandate reads the sentence itself.
 */
export const inWords = (err: unknown): unknown => {
  if (!(err instanceof AppError) || err.retryable) return err;
  const said = [err.problem.detail, err.problem.message].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return said && said !== err.message ? new AppError(said, err.status, err.problem, { cause: err }) : err;
};
const asked = <T>(call: Promise<T>): Promise<T> => call.catch((err: unknown) => Promise.reject(inWords(err)));

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
    return asked(this.client.get('/floor', { signal }));
  }
  yours(signal?: AbortSignal) {
    return asked(this.client.get('/me', { signal }));
  }
  home(signal?: AbortSignal) {
    return asked(this.client.get('/home', { signal }));
  }
  /** Intents the person can read, by the words of their title. */
  search(q: string) {
    return asked(this.client.get('/search', { query: { q } }));
  }
  thread(id: string, signal?: AbortSignal) {
    return asked(this.client.get('/threads', { query: { app: manifest.id, type: 'intent', id }, signal }));
  }
  say(id: string, kind: MessageKind, words: string) {
    return asked(this.client.post('/threads/messages', { body: { ref: { kind: 'ref', app: manifest.id, type: 'intent', id }, kind, words } }));
  }
  revisePart(id: string, change: RevisePartBody) {
    return asked(this.client.patch('/intents/{id}/passed', { params: { id }, body: change }));
  }
  intent(id: string, signal?: AbortSignal) {
    return asked(this.client.get('/intents/{id}', { params: { id }, signal }));
  }
  create(title: string, floorName: string) {
    return asked(this.client.post('/intents', { body: { title, floorName } }));
  }
  edit(id: string, change: EditBody) {
    return asked(this.client.patch('/intents/{id}', { params: { id }, body: change }));
  }
  issue(id: string) {
    return asked(this.client.post('/intents/{id}/issue', { params: { id } }));
  }
  targets(id: string, q: string) {
    return asked(this.client.get('/intents/{id}/targets', { params: { id }, query: { q } }));
  }
  passAgain(id: string, to: string) {
    return asked(this.client.post('/intents/{id}/pass-again', { params: { id }, body: { to } }));
  }
  pass(id: string, part: PassBody) {
    return asked(this.client.post('/intents/{id}/pass', { params: { id }, body: part }));
  }
  backBrief(id: string, brief: BackBriefBody) {
    return asked(this.client.post('/intents/{id}/back-brief', { params: { id }, body: brief }));
  }
  assess(id: string, rating: Rating, note: string) {
    return asked(this.client.post('/intents/{id}/assess', { params: { id }, body: { rating, note } }));
  }
  achieve(id: string, parts: CloseChoice = 'close') {
    return asked(this.client.post('/intents/{id}/achieve', { params: { id }, body: { parts } }));
  }
  withdraw(id: string, reason: string, parts: CloseChoice = 'close') {
    return asked(this.client.post('/intents/{id}/withdraw', { params: { id }, body: { reason, parts } }));
  }
  mainEffort(id: string, on: boolean) {
    return asked(this.client.post('/intents/{id}/main-effort', { params: { id }, body: { on } }));
  }
  bindEntity(id: string, entity: EntityRef, role: string) {
    return asked(this.client.post('/intents/{id}/entities', { params: { id }, body: { entity, role } }));
  }
  unbindEntity(id: string, entity: string, role: string) {
    return asked(this.client.delete('/intents/{id}/entities/{entity}', { params: { id, entity }, query: { role } }));
  }
  addDocument(id: string, document: DocumentRef) {
    return asked(this.client.post('/intents/{id}/documents', { params: { id }, body: { document } }));
  }
  removeDocument(id: string, document: DocumentRef) {
    return asked(this.client.delete('/intents/{id}/documents/{app}/{doc}', { params: { id, app: document.app, doc: document.id } }));
  }
}
