/**
 * Mandate's wire types: what crosses between its frontend and this service, written once.
 *
 * The service owns the API, so the file lives here; the frontend imports it with `import type` by relative
 * path (`../../service/src/api-types`). Types only: nothing here runs, so neither build changes. Keep it free
 * of imports, so the frontend's typecheck never pulls in the service's own modules.
 */

/** Where an intent is in its life. Separate from how its holder judges it is going (`Rating`). */
export type Life = 'draft' | 'passed' | 'active' | 'achieved' | 'superseded' | 'withdrawn';
/** How the holder judges an intent is going. */
export type Rating = 'on_track' | 'at_risk' | 'blocked' | 'achieved';
export type FloorKind = 'personal' | 'team' | 'org';
/** How far someone sees an intent: all of it, or its summary beside a part they see in full. */
export type Sight = 'full' | 'summary';

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

/** An entity from Data Atlas, as it crosses the wire (the SDK's EntityRef). The label is a cached name and may be stale. */
export interface EntityRef {
  kind: 'entity';
  id: string;
  type: string;
  label?: string;
  at?: string;
}

/** A document, as apps pass them (the SDK's DocumentRef). */
export interface DocumentRef {
  app: string;
  id: string;
  title: string;
  version?: string;
}

/** An intent as its summary shows it: in a tree, a list, or beside your own part. `sight` says whether the person may open it. */
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
  sight: Sight;
  /** The intent it's part of, in lists. */
  partOf?: string;
}

/** A summary with what's below it, as far as the viewer sees. */
export type Branch = Summary & { below: Branch[] };

export interface FloorItem extends Summary {
  counts: { parts: number; atRisk: number; blocked: number };
}

/** `GET /floor`: the intents on this floor, drafts, and what's closed. */
export interface Floor {
  intents: FloorItem[];
  drafts: FloorItem[];
  closed: FloorItem[];
  can: { create: boolean };
}

/** `GET /me`: what the person holds, or has been passed and not yet accepted. */
export interface Yours {
  passed: Summary[];
  recheck: Summary[];
  due: Summary[];
  holding: Summary[];
}

/** `GET /home`: Home's card. */
export interface HomeGlance {
  waiting: Summary[];
  due: number;
  holding: number;
  floor: { active: number; atRisk: number; blocked: number };
}

/** What the viewer may do with an intent they see in full, so the app only offers what will work. */
export interface Rights {
  /** Change the draft statement and title, and issue it. */
  edit: boolean;
  /** Pass part of it down to a team below or a person on its floor. */
  pass: boolean;
  /** Say it back and accept it, or raise a concern; or confirm a back-brief still stands. */
  backBrief: boolean;
  /** Say how it's going. */
  assess: boolean;
  /** Bind entities and documents to it. */
  bind: boolean;
  /** Close it as achieved: whoever passed it down, or for an intent set on its own floor, its holder. */
  achieve: boolean;
  /** Withdraw it, and everything below it. */
  withdraw: boolean;
  /** Mark it the main effort among its siblings: its parent's holder. */
  mainEffort: boolean;
}

export interface BackBrief {
  id: string;
  /** The version of the intent it answers. */
  version: number;
  /** The parent's version at the time. */
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

/** `GET /intents/:id`, and what each change to an intent answers: everything one intent's page shows. */
export interface Detail {
  intent: Summary;
  statement: Statement;
  /** The statement as its holder is writing it, for them alone. */
  draft?: Statement;
  issued?: { version: number; by: string; at: string };
  versions: { version: number; title: string; by: string; at: string }[];
  passed?: { by?: string; at?: string };
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

/** Someone or a team a part can be passed to. */
export interface Target {
  to: string;
  name: string;
  within?: string[];
  you?: boolean;
  email?: string;
}

/** `GET /intents/:id/targets`. */
export interface Targets {
  teams: Target[];
  people: Target[];
}

/** `GET /search`: intents the person can read, by the words of their title. */
export interface SearchResults {
  results: { id: string; title: string; detail: string; path?: string; workspace?: string }[];
}

/** `POST /intents`. */
export interface CreateBody {
  title: string;
  floorName?: string;
}

/** `PATCH /intents/:id`: changes the draft. */
export interface EditBody {
  title?: string;
  statement?: Partial<Statement>;
  byDate?: string | null;
  rhythmDays?: number;
}

/** `POST /intents/:id/pass`: a part passed down to a team below or a person on the floor. */
export interface PassBody {
  to: string;
  title: string;
  purpose?: string;
  byDate?: string;
  carry?: { entities?: string[]; documents?: string[] };
}

/** `POST /intents/:id/back-brief`. */
export interface BackBriefBody {
  words: string;
  concern?: string;
  outcome: 'accepted' | 'concern';
}

/** `POST /intents/:id/assess`. */
export interface AssessBody {
  rating: Rating;
  note?: string;
}

/** `POST /intents/:id/withdraw`. */
export interface WithdrawBody {
  reason?: string;
}

/** `POST /intents/:id/main-effort`. */
export interface MainEffortBody {
  on: boolean;
}

/** `POST /intents/:id/entities`. */
export interface BindEntityBody {
  entity: EntityRef;
  role: string;
}

/** `POST /intents/:id/documents`. */
export interface AddDocumentBody {
  document: DocumentRef;
}

/** What the service sends when it refuses: a code and words people can act on. */
export interface Problem {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// The routes the frontend calls, in the shape openapi-typescript writes a `paths` type, so Quill's
// `createAppClient<MandatePaths>` checks each call's path, parameters, body and answer. Every path is
// below the gateway's `/api/mandate/v1`. Other apps' routes (`/intents/{id}/context`,
// `/entities/{entity}/intents`) are left out until the service writes its contract from its routes (ADR 0055).

type Json<T> = { content: { 'application/json': T } };
type Takes = { path?: object; query?: object; body?: object };
/** One call: what it answers (with 200, or 201 for `Made`), and what it takes. */
type Call<Answer, Take extends Takes = Record<never, never>, Status extends 200 | 201 = 200> = {
  parameters: {
    path: Take extends { path: infer P } ? P : never;
    query: Take extends { query: infer Q } ? Q : never;
  };
  responses: { [S in Status]: Json<Answer> };
} & (Take extends { body: infer B } ? { requestBody: Json<B> } : Record<never, never>);
type Made<Answer, Take extends Takes> = Call<Answer, Take, 201>;
type ById = { id: string };

export interface MandatePaths {
  '/floor': { get: Call<Floor> };
  '/me': { get: Call<Yours> };
  '/home': { get: Call<HomeGlance> };
  '/search': { get: Call<SearchResults, { query: { q?: string } }> };
  '/intents': { post: Made<Summary, { body: CreateBody }> };
  '/intents/{id}': { get: Call<Detail, { path: ById }>; patch: Call<Detail, { path: ById; body: EditBody }> };
  '/intents/{id}/issue': { post: Call<Detail, { path: ById }> };
  '/intents/{id}/targets': { get: Call<Targets, { path: ById; query: { q?: string } }> };
  '/intents/{id}/pass': { post: Made<Summary, { path: ById; body: PassBody }> };
  '/intents/{id}/back-brief': { post: Call<Detail, { path: ById; body: BackBriefBody }> };
  '/intents/{id}/assess': { post: Call<Detail, { path: ById; body: AssessBody }> };
  '/intents/{id}/achieve': { post: Call<Detail, { path: ById }> };
  '/intents/{id}/withdraw': { post: Call<Detail, { path: ById; body: WithdrawBody }> };
  '/intents/{id}/main-effort': { post: Call<Detail, { path: ById; body: MainEffortBody }> };
  '/intents/{id}/entities': { post: Call<Detail, { path: ById; body: BindEntityBody }> };
  '/intents/{id}/entities/{entity}': { delete: Call<Detail, { path: ById & { entity: string }; query: { role: string } }> };
  '/intents/{id}/documents': { post: Call<Detail, { path: ById; body: AddDocumentBody }> };
  '/intents/{id}/documents/{app}/{doc}': { delete: Call<Detail, { path: ById & { app: string; doc: string } }> };
}
