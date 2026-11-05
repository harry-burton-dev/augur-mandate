// Mandate's scenarios for AUGUR's run suite (augur-run, im-platform ADR 0050). The suite loads this module
// with `--scenarios ../augur-mandate/run/index.ts`; each scenario has a row in augur-run's traceability.md.
// The suite runs it from source on Node's type stripping, so it imports nothing and uses only syntax Node
// can strip. The types below are the parts of augur-run's `src/scenario.ts` these scenarios use.

type Answer<T> = { status: number; ok: boolean; body: T };
type Api = {
  get: <T = unknown>(path: string, opts?: { floor?: string }) => Promise<Answer<T>>;
  post: <T = unknown>(path: string, body?: unknown, opts?: { floor?: string }) => Promise<Answer<T>>;
  delete: <T = unknown>(path: string, opts?: { floor?: string }) => Promise<Answer<T>>;
};
type Persona = { key: string; name: string };
type CastEntity = { type: string; label: string; floor?: string };
type Context = {
  parts: Record<string, { persona: Persona; api: Api }>;
  cast: { entities?: CastEntity[] };
  check: (label: string, ok: boolean, detail?: { expected?: unknown; actual?: unknown }) => boolean;
  note: (text: string, data?: unknown) => void;
  eventually: <T>(probe: () => Promise<{ ok: boolean; value: T }>, o: { withinMs: number; everyMs?: number }) => Promise<{ ok: boolean; value: T; ms: number }>;
  state: Record<string, unknown>;
};
type Scenario = {
  id: string;
  title: string;
  owner: string;
  goals: number[];
  cuj?: number;
  given: string;
  when: string;
  then: string;
  cadence: { kind: 'every'; minutes: number; quietMinutes?: number };
  needs: { as: string; role?: string; floors?: 'own' | 'none' }[];
  run: (ctx: Context) => Promise<void>;
};

const MANDATE = '/api/mandate/v1';
const ATLAS = '/api/atlas/v1';
const WORKSPACES = '/api/identity/v1/me/workspaces';

/** The intent the scenario keeps on the person's own floor, found again by its title if the state is lost. */
const TITLE = 'Kept by the run suite: what this intent is about';
/** How long Data Atlas may take to hear of a binding from Mandate's events. */
const HEARS_WITHIN_MS = 5 * 60_000;
const ROLE = 'subject';

type Floor = { id: string; kind: string; name: string };
type Entity = { id: string; type: string; label: string };
type Bound = { intents: { id: string; role: string }[] };
type UsedBy = { intents: { app: string; id: string; role: string }[] };
type Kept = { floor: string; intent: string };

/** The person's own floor, and the intent the scenario keeps there: made once, then found again. */
const keptIntent = async (ctx: Context, api: Api): Promise<Kept | undefined> => {
  const kept = ctx.state.kept as Kept | undefined;
  if (kept && (await api.get(`${MANDATE}/intents/${encodeURIComponent(kept.intent)}`, { floor: kept.floor })).ok) return kept;

  const floors = await api.get<{ workspaces: Floor[] }>(WORKSPACES);
  const own = floors.ok ? floors.body.workspaces.find((f) => f.kind === 'personal') : undefined;
  if (!ctx.check('the person has a floor of their own', !!own, { actual: floors.status })) return undefined;

  const found = await api.get<{ results: { id: string; title: string }[] }>(`${MANDATE}/search?q=${encodeURIComponent(TITLE)}`, { floor: own!.id });
  const again = found.ok ? found.body.results.find((r) => r.title === TITLE) : undefined;
  if (again) return (ctx.state.kept = { floor: own!.id, intent: again.id });

  const made = await api.post<{ id: string }>(`${MANDATE}/intents`, { title: TITLE }, { floor: own!.id });
  if (!ctx.check('the person sets an intent on their own floor', made.status === 201, { expected: 201, actual: made.status })) return undefined;
  return (ctx.state.kept = { floor: own!.id, intent: made.body.id });
};

/**
 * Binding events, followed by Data Atlas (alpha Goals 29 and 33a, CUJ 6): an intent bound to something
 * AUGUR knows about lists it in Mandate and shows in Data Atlas as using it; unbound, both forget it.
 */
export const bindingAnEntity: Scenario = {
  id: 'RUN-19',
  title: 'An intent bound to an entity shows in Data Atlas as using it, until it is unbound',
  owner: 'mandate',
  goals: [29],
  cuj: 6,
  given: 'A person with an intent of their own, and an entity from the seed’s cast that Data Atlas knows.',
  when: 'They say the intent is about that entity, then take it back.',
  then: 'Mandate lists the intent under the entity, Data Atlas shows the intent among what uses it within five minutes, and both forget it once it is unbound.',
  cadence: { kind: 'every', minutes: 180, quietMinutes: 360 },
  needs: [{ as: 'holder', floors: 'own' }],
  run: async (ctx) => {
    const { persona, api } = ctx.parts.holder!;
    // An entity the seed puts on the organisation's floor, so anyone on it can see it.
    const wanted = ctx.cast.entities?.find((e) => !e.floor || e.floor === 'org');
    if (!wanted) return ctx.note('The seed’s cast has no entity on the organisation’s floor, so there is nothing to bind. Add one to the cast.');

    const kept = await keptIntent(ctx, api);
    if (!kept) return;

    const q = new URLSearchParams({ q: wanted.label, type: wanted.type });
    const list = await api.get<{ entities: Entity[] }>(`${ATLAS}/entities?${q}`, { floor: kept.floor });
    const entity = list.ok ? list.body.entities.find((e) => e.label === wanted.label && e.type === wanted.type) : undefined;
    if (!ctx.check(`Data Atlas finds the seed’s “${wanted.label}”`, !!entity, { actual: list.ok ? list.body.entities.map((e) => e.label) : list.status })) return;

    const intentPath = `${MANDATE}/intents/${encodeURIComponent(kept.intent)}`;
    const bound = await api.post(`${intentPath}/entities`, { entity: { kind: 'entity', id: entity!.id, type: entity!.type, label: entity!.label }, role: ROLE }, { floor: kept.floor });
    if (!ctx.check(`${persona.name} says their intent is about ${entity!.label}`, bound.ok, { actual: bound.status })) return;

    const listed = async () => {
      const r = await api.get<Bound>(`${MANDATE}/entities/${encodeURIComponent(entity!.id)}/intents`, { floor: kept.floor });
      return r.ok && r.body.intents.some((i) => i.id === kept.intent && i.role === ROLE);
    };
    ctx.check('Mandate lists the intent under the entity, with its role', await listed());

    const usedBy = async () => {
      const r = await api.get<UsedBy>(`${ATLAS}/entities/${encodeURIComponent(entity!.id)}/used-by`, { floor: kept.floor });
      return r.ok && r.body.intents.some((i) => i.app === 'mandate' && i.id === kept.intent && i.role === ROLE);
    };
    const heard = await ctx.eventually(async () => ({ ok: await usedBy(), value: undefined }), { withinMs: HEARS_WITHIN_MS });
    ctx.check('Data Atlas shows the intent among what uses the entity', heard.ok, { expected: `within ${HEARS_WITHIN_MS / 60_000} minutes`, actual: `${Math.round(heard.ms / 1000)}s` });

    const unbound = await api.delete(`${intentPath}/entities/${encodeURIComponent(entity!.id)}?role=${ROLE}`, { floor: kept.floor });
    if (!ctx.check(`${persona.name} takes it back`, unbound.ok, { actual: unbound.status })) return;
    ctx.check('Mandate no longer lists the intent under the entity', !(await listed()));
    const forgot = await ctx.eventually(async () => ({ ok: !(await usedBy()), value: undefined }), { withinMs: HEARS_WITHIN_MS });
    ctx.check('Data Atlas forgets the intent once it is unbound', forgot.ok, { expected: `within ${HEARS_WITHIN_MS / 60_000} minutes`, actual: `${Math.round(forgot.ms / 1000)}s` });
  },
};

export const scenarios = [bindingAnEntity];
