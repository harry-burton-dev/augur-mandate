import type { Workspace } from '@augur/mfe-sdk';
import { fakeContext, type FakeContextOptions } from '@augur/mfe-sdk/testing';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../manifest.json';
import app, { AIM_OPEN, AIM_PICK, MANDATE_OPEN, startFor } from './entry.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const floor: Partial<Workspace> = {
  id: 'eng',
  kind: 'team',
  name: 'Engineering',
  slug: 'eng',
  role: 'lead',
};

const summary = (id: string, title: string, extra: object = {}) => ({
  id,
  root: id,
  title,
  floorName: 'Engineering',
  floorKind: 'team',
  holder: 'floor',
  holderName: 'Engineering',
  life: 'active',
  version: 1,
  mainEffort: false,
  sight: 'full',
  ...extra,
});

const DETAIL = {
  intent: summary('a1', 'Keep the fleet at sea', {
    rating: 'at_risk',
    ratingNote: 'Two hulls in dock',
    ratedAt: new Date().toISOString(),
  }),
  statement: {
    mission: 'Keep four ships ready',
    purpose: 'So the coast is watched',
    endState: 'Four at sea, all year',
    keyTasks: ['Refit Hull 4'],
    constraints: '',
    restraints: 'No overtime',
    freedoms: '',
  },
  versions: [
    {
      version: 1,
      title: 'Keep the fleet at sea',
      by: 'Dana Reyes',
      at: new Date().toISOString(),
    },
  ],
  rhythmDays: 7,
  lineOfSight: [],
  below: [
    {
      ...summary('a2', 'Refit Hull 4', {
        parent: 'a1',
        holder: 'person:jo',
        holderName: 'Jo Hart',
        life: 'passed',
      }),
      below: [],
    },
  ],
  backBriefs: [],
  assessments: [
    {
      id: 's1',
      byName: 'Dana Reyes',
      rating: 'at_risk',
      note: 'Two hulls in dock',
      at: new Date().toISOString(),
    },
  ],
  entities: [
    {
      entity: {
        kind: 'entity',
        id: 'ent_01J0000000000000000000SHIP',
        type: 'ship',
        label: 'HMS Example',
      },
      role: 'subject',
      at: new Date().toISOString(),
    },
  ],
  documents: [],
  recheck: false,
  assessmentDue: false,
  can: {
    edit: true,
    pass: true,
    backBrief: false,
    assess: true,
    bind: true,
    achieve: false,
    withdraw: true,
    mainEffort: false,
    passAgain: false,
  },
};

/** Jo's part, after Jo left: Engineering's lead passed it down, so they pass it again. */
const ORPHAN = {
  ...DETAIL,
  intent: summary('a2', 'Refit Hull 4', { parent: 'a1', holder: 'person:jo', holderName: 'Jo Hart', needsHolder: { why: 'left', since: new Date().toISOString() } }),
  lineOfSight: [{ ...summary('a1', 'Keep the fleet at sea'), mission: '', purpose: 'So the coast is watched', endState: '' }],
  below: [],
  passed: { by: 'Dana Reyes', at: new Date().toISOString() },
  entities: [{ ...DETAIL.entities[0], state: 'retired' }],
  can: { ...DETAIL.can, edit: false, pass: false, assess: false, passAgain: true },
};

/** Answers Mandate's service the way it would for a lead on Engineering. */
const service = vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname;
  if (!path.startsWith(`/api/${manifest.id}/v1/`)) return new Response(null, { status: 404 });
  if (path.endsWith('/v1/floor'))
    return Response.json({
      intents: [
        {
          ...summary('a1', 'Keep the fleet at sea'),
          counts: { parts: 2, atRisk: 1, blocked: 0 },
        },
      ],
      drafts: [],
      closed: [],
      can: { create: true },
    });
  if (path.endsWith('/v1/me'))
    return Response.json({
      passed: [
        summary('a2', 'Refit Hull 4', {
          life: 'passed',
          partOf: 'Keep the fleet at sea',
        }),
      ],
      recheck: [],
      due: [],
      holding: [],
    });
  if (path.endsWith('/v1/home'))
    return Response.json({
      waiting: [
        summary('a2', 'Refit Hull 4', {
          life: 'passed',
          partOf: 'Keep the fleet at sea',
        }),
      ],
      due: 0,
      holding: 1,
      floor: { active: 1, atRisk: 1, blocked: 0 },
    });
  if (path.endsWith('/v1/intents/a1')) return Response.json(DETAIL);
  if (path.endsWith('/v1/intents/a2')) return Response.json(ORPHAN);
  return new Response(null, { status: 404 });
});

/** The shell's mount context on Engineering, its fetch ending at the service above. */
const ctx = (over: FakeContextOptions = {}) => fakeContext({ workspace: floor, fetch: service as unknown as typeof fetch, ...over });

/** Where Mandate is mounted on Engineering, as the address bar has it. */
const ROUTE = `/t/eng${manifest.route}`;

/** Lets the service's answers land, and the router and React draw them. */
const settle = async () => {
  for (let n = 0; n < 8; n++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const press = (b: Element | undefined) => act(() => (b as HTMLElement).click());
const button = (el: Element, words: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(words));
const rows = (el: Element) => [...el.querySelectorAll('.quill-list-row')];

const open: HTMLElement[] = [];
/** Mounts Mandate at `path` below its route, as the shell does. */
const mounted = async (path = '/', over: FakeContextOptions = {}) => {
  window.history.replaceState(null, '', `${ROUTE}${path === '/' ? '' : path}`);
  const el = document.body.appendChild(document.createElement('div'));
  const c = ctx({ path, ...over });
  open.push(el);
  await act(() => void app.mount(el, c));
  await settle();
  return { el, c };
};
afterEach(async () => {
  for (const el of open.splice(0)) await act(() => void app.unmount(el));
});

describe('mandate', () => {
  it('opens at the place an intent names', () => {
    expect(startFor[AIM_OPEN]!({ id: 'a1' })).toBe('/intents/a1');
    expect(startFor[MANDATE_OPEN]!({ path: '/yours' })).toBe('/yours');
    expect(startFor[MANDATE_OPEN]!({ path: 'https://elsewhere' })).toBeUndefined();
    expect(startFor[AIM_OPEN]!({})).toBeUndefined();
  });

  it('shows the floor’s intent, and clears up on unmount', async () => {
    const { el } = await mounted();
    expect(el.querySelector('.quill-card-title')!.textContent).toBe('Keep the fleet at sea');
    expect(el.querySelector('.quill-tally-words')!.textContent).toContain('1 at risk');
    await act(() => void app.unmount(el));
    expect(el.textContent).toBe('');
  });

  it('goes to an intent on the address bar, and Back comes to the floor again', async () => {
    const { el } = await mounted();
    await press(el.querySelector('.quill-card-title')!.closest('button') ?? el.querySelector('.quill-card-title')!);
    await settle();
    expect(window.location.pathname).toBe(`${ROUTE}/intents/a1`);
    expect(el.querySelector('.mandate-statement')).not.toBeNull();
    await act(async () => window.history.back());
    await settle();
    expect(window.location.pathname).toBe(ROUTE);
    expect(el.querySelector('.quill-card-title')!.textContent).toBe('Keep the fleet at sea');
  });

  it('shows an intent’s statement, its parts below and what it’s bound to, and opens the entity in Data Atlas', async () => {
    const { el, c } = await mounted('/intents/a1');
    const statement = [...el.querySelectorAll('.mandate-statement dd')].map((p) => p.textContent);
    for (const words of ['So the coast is watched', 'No overtime', 'Refit Hull 4']) expect(statement).toContain(words);
    for (const words of ['Refit Hull 4', 'Two hulls in dock']) expect(el.textContent).toContain(words);
    const chip = el.querySelector('.quill-ref-open')!;
    expect(chip.textContent).toContain('HMS Example');
    await press(chip);
    expect(c.raised).toEqual([
      {
        type: 'entity.open',
        payload: {
          kind: 'entity',
          id: 'ent_01J0000000000000000000SHIP',
          type: 'ship',
          label: 'HMS Example',
        },
      },
    ]);
  });

  it('says a part needs a holder, and offers whoever passed it down to pass it again', async () => {
    const { el } = await mounted('/intents/a2');
    expect(el.textContent).toContain('Needs a holder');
    expect(el.textContent).toContain('Jo Hart no longer holds this: they left');
    expect(el.textContent).toContain('HMS Example (retired in Data Atlas)');
    expect(button(el, 'Pass it again')).toBeDefined();
  });

  it('says a refusal in the service’s own words', async () => {
    // As the service kit sends one: a code in `reason`, the sentence in `detail` and `message`.
    const words = 'Only this floor’s members can read its intent.';
    const refused = async () =>
      Response.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, reason: 'forbidden', detail: words, error: 'forbidden', message: words },
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      );
    // What Mandate loaded is kept per floor, so this asks on a floor of its own.
    const { el } = await mounted('/', { fetch: refused as unknown as typeof fetch, workspace: { ...floor, id: 'elsewhere' } });
    expect(el.textContent).toContain(words);
    expect(el.textContent).not.toContain('forbidden');
  });

  it('says why entities can’t be bound while no app picks them, rather than hiding it', async () => {
    // No answer for entity.pick: the fake shell says no app handles it, as AUGUR does without Data Atlas.
    const { el, c } = await mounted('/intents/a1');
    await press(button(el, 'Bind an entity'));
    await settle();
    expect(c.requested).toEqual([{ type: 'entity.pick', payload: { purpose: 'Bind to this intent' } }]);
    expect(button(el, 'Bind an entity')!.getAttribute('aria-disabled')).toBe('true');
    expect(el.textContent).toContain('Linking to entities arrives with Data Atlas.');
  });

  it('answers aim.pick with the intent chosen', async () => {
    const { el, c } = await mounted('/', { intent: { type: AIM_PICK, payload: { purpose: 'Brief on' } }, reply: true });
    expect(el.textContent).toContain('Brief on');
    await press(rows(el)[0]);
    expect(c.reply!.responses).toEqual([
      {
        kind: 'intent',
        app: 'mandate',
        id: 'a1',
        title: 'Keep the fleet at sea',
      },
    ]);
  });

  it('shows what’s waiting on Home, and opens it', async () => {
    const c = ctx();
    const el = document.body.appendChild(document.createElement('div'));
    await act(() => void app.surfaces['./Glance']!.mount(el, c));
    await settle();
    expect(el.textContent).toContain('What you hold (1)');
    await press(rows(el)[0]);
    await press(button(el, 'What you hold'));
    expect(c.raised).toEqual([
      { type: AIM_OPEN, payload: { id: 'a2' } },
      { type: MANDATE_OPEN, payload: { path: '/yours' } },
    ]);
    await act(() => void app.surfaces['./Glance']!.unmount(el));
  });
});
