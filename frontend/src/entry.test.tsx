import { createEventBus, type MountContext, type Workspace } from '@augur/mfe-sdk';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import app, { AIM_OPEN, AIM_PICK, MANDATE_OPEN, addressFor, placeForIntent } from './entry.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const floor: Workspace = {
  id: 'eng',
  kind: 'team',
  name: 'Engineering',
  slug: 'eng',
  path: [],
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
  },
};

/** Answers Mandate's service the way it would for a lead on Engineering. */
const service = vi.fn(async (path: string) => {
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
  return new Response(null, { status: 404 });
});

const ctx = (over: Partial<MountContext> = {}): MountContext => ({
  user: { id: 'dana', name: 'Dana Reyes', departments: [], roles: [] },
  getToken: async () => 't',
  bus: createEventBus(),
  raise: vi.fn(async () => {}),
  request: vi.fn(),
  notify: vi.fn(),
  path: '/',
  workspace: floor,
  getWorkspace: () => floor,
  previewOn: () => false,
  fetch: service as unknown as MountContext['fetch'],
  ...over,
});

/** Lets the service's answers land and React draw them. */
const settle = async () => {
  for (let n = 0; n < 5; n++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const press = (b: Element | undefined) => act(() => (b as HTMLElement).click());
const button = (el: Element, words: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(words));
const rows = (el: Element) => [...el.querySelectorAll('.quill-list-row')];
const mounted = async (over: Partial<MountContext> = {}) => {
  const el = document.body.appendChild(document.createElement('div'));
  await act(() => void app.mount(el, ctx(over)));
  await settle();
  return el;
};

describe('mandate', () => {
  it('opens at the place its address or an intent names', () => {
    expect(placeForIntent({ type: AIM_OPEN, payload: { id: 'a1' } })).toEqual({
      view: 'intent',
      id: 'a1',
    });
    expect(placeForIntent({ type: MANDATE_OPEN, payload: { path: '/yours' } })).toEqual({ view: 'yours' });
    expect(placeForIntent({ type: 'document.open', payload: {} })).toBeUndefined();
    expect(
      addressFor('/t/eng/mandate/yours', '/yours', {
        view: 'intent',
        id: 'a1',
      }),
    ).toBe('/t/eng/mandate/intents/a1');
    expect(addressFor('/t/eng/mandate', '/', { view: 'yours' })).toBe('/t/eng/mandate/yours');
  });

  it('shows the floor’s intent, and clears up on unmount', async () => {
    const el = await mounted();
    expect(el.querySelector('.quill-card-title')!.textContent).toBe('Keep the fleet at sea');
    expect(el.querySelector('.quill-tally-words')!.textContent).toContain('1 at risk');
    await act(() => void app.unmount!(el));
    expect(el.textContent).toBe('');
  });

  it('shows an intent’s statement, its parts below and what it’s bound to, and opens the entity in Data Atlas', async () => {
    const raise = vi.fn(async () => {});
    const el = await mounted({ path: '/intents/a1', raise });
    const statement = [...el.querySelectorAll('.mandate-statement dd')].map((p) => p.textContent);
    for (const words of ['So the coast is watched', 'No overtime', 'Refit Hull 4']) expect(statement).toContain(words);
    for (const words of ['Refit Hull 4', 'Two hulls in dock']) expect(el.textContent).toContain(words);
    const chip = el.querySelector('.quill-ref-open')!;
    expect(chip.textContent).toContain('HMS Example');
    await press(chip);
    expect(raise).toHaveBeenCalledWith({
      type: 'entity.open',
      payload: {
        kind: 'entity',
        id: 'ent_01J0000000000000000000SHIP',
        type: 'ship',
        label: 'HMS Example',
      },
    });
  });

  it('says why entities can’t be bound while no app picks them, rather than hiding it', async () => {
    const request = vi.fn(async () => {
      const { IntentError } = await import('@augur/mfe-sdk');
      throw new IntentError('No app handles entity.pick');
    });
    const el = await mounted({
      path: '/intents/a1',
      request: request as unknown as MountContext['request'],
    });
    await press(button(el, 'Bind an entity'));
    await settle();
    expect(request).toHaveBeenCalledWith({
      type: 'entity.pick',
      payload: { purpose: 'Bind to this intent' },
    });
    expect(button(el, 'Bind an entity')!.getAttribute('aria-disabled')).toBe('true');
    expect(el.textContent).toContain('Linking to entities arrives with Data Atlas.');
  });

  it('answers aim.pick with the intent chosen', async () => {
    const respond = vi.fn();
    const el = await mounted({
      intent: { type: AIM_PICK, payload: { purpose: 'Brief on' } },
      reply: { respond, cancel: vi.fn() },
    });
    expect(el.textContent).toContain('Brief on');
    await press(rows(el)[0]);
    expect(respond).toHaveBeenCalledWith({
      kind: 'intent',
      app: 'mandate',
      id: 'a1',
      title: 'Keep the fleet at sea',
    });
  });

  it('shows what’s waiting on Home, and opens it', async () => {
    const raise = vi.fn(async () => {});
    const el = document.body.appendChild(document.createElement('div'));
    await act(() => void app.surfaces!['./Glance']!.mount(el, ctx({ raise })));
    await settle();
    expect(el.textContent).toContain('What you hold (1)');
    await press(rows(el)[0]);
    expect(raise).toHaveBeenCalledWith({
      type: AIM_OPEN,
      payload: { id: 'a2' },
    });
    await press(button(el, 'What you hold'));
    expect(raise).toHaveBeenCalledWith({
      type: MANDATE_OPEN,
      payload: { path: '/yours' },
    });
  });
});
