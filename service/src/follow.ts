import { bindingEvent, PLATFORM_TOPICS, type DomainEvent, type NewInboxItem } from '@augur/service-kit';
import type { NeedsHolder } from './api-types.ts';
import type { Audit } from './audit.ts';
import { INBOX_KINDS, needsHolderKey } from './inbox.ts';
import type { Notify } from './notices.ts';
import type { People } from './people.ts';
import { ended } from './rules.ts';
import { TOPICS, type Change, type EntityBinding, type Intent, type MandateStore, type OutboxEvent } from './store.ts';

/**
 * What Mandate follows (MB1), and what it does about each. Every handler can run twice without harm:
 * `followEvents` hands an event again when the one before failed part-way.
 *
 * - Someone signed out for good, or gone: each open part passed to them needs a new holder, and
 *   whoever passed it down is asked, in their Inbox, to pass it again. Signed back in: it's theirs again.
 * - Someone off a team: the parts passed to them on that team's floor need a new holder.
 * - A team renamed: its floor's intents show the new name.
 * - An entity retired in Data Atlas: its chips say so. Merged: the bindings move to the survivor.
 *   Split again: they move back.
 */
export const ATLAS_TOPICS = { retired: 'atlas.entity.retired', merged: 'atlas.entity.merged', split: 'atlas.entity.split' } as const;

export const FOLLOWED = [
  PLATFORM_TOPICS.personDisabled,
  PLATFORM_TOPICS.personEnabled,
  PLATFORM_TOPICS.personLeft,
  PLATFORM_TOPICS.memberRemoved,
  PLATFORM_TOPICS.teamRenamed,
  ATLAS_TOPICS.retired,
  ATLAS_TOPICS.merged,
  ATLAS_TOPICS.split,
];

export interface FollowerOptions {
  /** Mandate's id and name, from its manifest. */
  app: { id: string; name: string };
  store: MandateStore;
  people: People;
  audit: Audit;
  notify: Notify;
  inbox: { put(key: string, workspace: string, item: NewInboxItem): Promise<void>; close(key: string, state: 'done' | 'withdrawn'): Promise<void> };
  now?: () => Date;
}

const text = (p: Record<string, unknown>, key: string) => (typeof p[key] === 'string' && p[key] ? (p[key] as string) : undefined);
const personOf = (holder: string) => (holder.startsWith('person:') ? holder.slice('person:'.length) : undefined);

const WHY: Record<NeedsHolder['why'], string> = {
  disabled: 'their sign-in was turned off',
  left: 'they left',
  removed: 'they’re no longer on the team',
};

/** Words for why a part needs a new holder: "Sam Patel no longer holds this: they left." */
export const needsHolderWords = (i: Pick<Intent, 'holderName'>, n: NeedsHolder) => `${i.holderName || 'Its holder'} no longer holds this: ${WHY[n.why]}.`;

/** The event for a binding made or taken away, in ADR 0066's shape (`mandate.intent.entity-bound`). */
export const bindingOutbox = (app: string, b: Pick<EntityBinding, 'intent' | 'role'> & { entity: string }, change: 'bound' | 'unbound', workspace: string): OutboxEvent => {
  const e = bindingEvent({ app, type: 'intent', id: b.intent, entity: b.entity, role: b.role }, change, workspace);
  return { topic: e.topic, workspace, payload: e.payload as Record<string, unknown> };
};

export const makeFollower = ({ app, store, people, audit, notify, inbox, now = () => new Date() }: FollowerOptions) => {
  const event = (topic: string, i: Intent, payload: Record<string, unknown> = {}): OutboxEvent => ({ topic, workspace: i.workspace, payload: { intent: i.id, ...payload } });

  /** Who passed a part down, or else the leads of the floor above: they pass it again. */
  const askToPassAgain = async (part: Intent, parent: Intent | undefined, n: NeedsHolder, handOver?: string) => {
    const giver = part.passedBy ?? (parent ? personOf(parent.holder) : undefined);
    const owner = giver ? ({ kind: 'person', id: giver } as const) : parent ? ({ kind: 'team', id: parent.workspace, role: 'lead' } as const) : undefined;
    if (!owner) return;
    const words = `${needsHolderWords(part, n)}${handOver ? ` They handed their work over to ${handOver}.` : ''}`;
    await inbox.put(needsHolderKey(part.id), parent?.workspace ?? part.workspace, {
      kind: INBOX_KINDS.needsHolder,
      owner,
      title: part.title,
      detail: `${words} Pass it to someone else, or withdraw it.`,
      subject: { kind: 'ref', app: app.id, type: 'intent', id: part.id, label: part.title },
      path: `/intents/${part.id}`,
      // Passing it again or withdrawing it is Mandate's own step.
      allow: { decline: false, handOn: false, selfComplete: false },
      reopen: true,
    });
    if (giver) await notify({ recipients: [giver], workspace: parent?.workspace ?? part.workspace, title: `“${part.title}” needs a holder`, detail: words, needsYou: true, link: `/intents/${part.id}` });
  };

  /** Marks open parts as needing a holder. Parts already marked keep the first reason and date. */
  const loseHolder = async (parts: Intent[], why: NeedsHolder['why'], handOver?: string) => {
    const at = now().toISOString();
    const open = parts.filter((i) => !ended(i) && !i.needsHolder && i.parent);
    if (!open.length) return;
    const marked = open.map((i): Intent => ({ ...i, needsHolder: { why, since: at }, updatedAt: at }));
    await store.commit({ intents: marked, events: marked.map((i) => event(TOPICS.needsHolder, i, { why })) });
    const parents = new Map((await store.intents([...new Set(marked.map((i) => i.parent!))])).map((p) => [p.id, p]));
    for (const i of marked) {
      await audit({ actor: app.id, service: true, action: 'intent.needs-holder', target: i.id, workspace: i.workspace, detail: { title: i.title, holder: i.holder, why } });
      await askToPassAgain(i, parents.get(i.parent!), i.needsHolder!, handOver);
    }
  };

  /** Someone gone: what they held needs a new holder. A leaver's handover is named, as a suggestion, never passed on unasked. */
  const personGone = async (person: string, why: NeedsHolder['why'], handOverTo?: string) => {
    const handOver = handOverTo ? (await people.directory({ ids: [handOverTo] }).catch(() => ({ people: [] as { id: string; name: string }[] }))).people.find((p) => p.id === handOverTo)?.name : undefined;
    return loseHolder(await store.heldBy(person), why, handOver);
  };

  /** Signed back in: what they held and nobody has taken on is theirs again. */
  const personBack = async (person: string) => {
    const at = now().toISOString();
    const back = (await store.heldBy(person)).filter((i) => i.needsHolder?.why === 'disabled' && !ended(i));
    if (!back.length) return;
    await store.commit({ intents: back.map(({ needsHolder: _, ...i }): Intent => ({ ...i, updatedAt: at })) });
    for (const i of back) await inbox.close(needsHolderKey(i.id), 'withdrawn');
  };

  const teamRenamed = async (team: string, named?: string) => {
    const name = named ?? (await people.directory({ ids: [team] })).teams.find((t) => t.id === team)?.name;
    if (!name) return;
    const at = now().toISOString();
    const changed = (await store.onFloor(team))
      .filter((i) => i.floorKind === 'team' && (i.floorName !== name || (i.holder === 'floor' && i.holderName !== name)))
      .map((i): Intent => ({ ...i, floorName: name, ...(i.holder === 'floor' ? { holderName: name } : {}), updatedAt: at }));
    if (changed.length) await store.commit({ intents: changed });
  };

  /**
   * Data Atlas merged `junior` into `senior`. Each binding moves to the survivor, saying where it
   * came from. Where the intent was already bound to the survivor in that role, the old row is kept out
   * of sight instead, so a split can bring it back.
   */
  const merged = async (junior: string, senior: string) => {
    const moving = await store.boundTo(junior);
    if (!moving.length) return;
    const already = new Set((await store.boundTo(senior)).map((b) => `${b.intent}|${b.role}`));
    const intents = new Map((await store.intents([...new Set(moving.map((b) => b.intent))])).map((i) => [i.id, i]));
    const change: Required<Pick<Change, 'unbindEntities' | 'entityBindings' | 'bindingStates' | 'events'>> = { unbindEntities: [], entityBindings: [], bindingStates: [], events: [] };
    for (const b of moving) {
      const workspace = intents.get(b.intent)?.workspace ?? '';
      if (already.has(`${b.intent}|${b.role}`)) change.bindingStates.push({ intent: b.intent, entity: junior, role: b.role, state: 'merged' });
      else {
        change.unbindEntities.push({ intent: b.intent, entity: junior, role: b.role });
        change.entityBindings.push({ ...b, entity: { ...b.entity, id: senior }, mergedFrom: junior });
        change.events.push(bindingOutbox(app.id, { ...b, entity: senior }, 'bound', workspace));
      }
      change.events.push(bindingOutbox(app.id, { ...b, entity: junior }, 'unbound', workspace));
    }
    await store.commit(change);
    for (const b of moving)
      await audit({ actor: app.id, service: true, action: 'binding.repointed', target: b.intent, workspace: intents.get(b.intent)?.workspace ?? '', detail: { from: junior, into: senior, role: b.role, alreadyBound: already.has(`${b.intent}|${b.role}`) } });
  };

  /** Data Atlas split `junior` back out of `senior`: what the merge moved goes back. */
  const split = async (junior: string, senior: string) => {
    const moved = (await store.mergedFrom(junior)).filter((b) => b.entity.id === senior);
    const hidden = (await store.boundTo(junior, true)).filter((b) => b.state === 'merged');
    if (!moved.length && !hidden.length) return;
    const intents = new Map((await store.intents([...new Set([...moved, ...hidden].map((b) => b.intent))])).map((i) => [i.id, i]));
    const where = (b: EntityBinding) => intents.get(b.intent)?.workspace ?? '';
    await store.commit({
      unbindEntities: moved.map((b) => ({ intent: b.intent, entity: senior, role: b.role })),
      entityBindings: moved.map(({ mergedFrom: _, ...b }) => ({ ...b, entity: { ...b.entity, id: junior } })),
      bindingStates: hidden.map((b) => ({ intent: b.intent, entity: junior, role: b.role, state: 'active' })),
      events: [
        ...moved.flatMap((b) => [bindingOutbox(app.id, { ...b, entity: senior }, 'unbound', where(b)), bindingOutbox(app.id, { ...b, entity: junior }, 'bound', where(b))]),
        ...hidden.map((b) => bindingOutbox(app.id, { ...b, entity: junior }, 'bound', where(b))),
      ],
    });
  };

  const dispatch = async (e: Pick<DomainEvent, 'topic' | 'payload'>): Promise<unknown> => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const person = text(p, 'person');
    const team = text(p, 'team');
    const entity = text(p, 'entity');
    switch (e.topic) {
      case PLATFORM_TOPICS.personDisabled:
        return person && personGone(person, 'disabled');
      case PLATFORM_TOPICS.personLeft:
        return person && personGone(person, 'left', text(p, 'handOverTo'));
      case PLATFORM_TOPICS.personEnabled:
        return person && personBack(person);
      case PLATFORM_TOPICS.memberRemoved:
        // Only parts passed to them on that team's floor: what they hold elsewhere is still theirs.
        return person && team && loseHolder((await store.heldBy(person)).filter((i) => i.workspace === team && i.floorKind === 'team'), 'removed');
      case PLATFORM_TOPICS.teamRenamed:
        return team && teamRenamed(team, text(p, 'name'));
      case ATLAS_TOPICS.retired:
        return entity && store.commit({ entityStates: [{ entity, state: 'retired' }] });
      case ATLAS_TOPICS.merged:
        return entity && text(p, 'into') && merged(entity, text(p, 'into')!);
      case ATLAS_TOPICS.split:
        return entity && text(p, 'from') && split(entity, text(p, 'from')!);
      default:
        return undefined;
    }
  };

  /** Handles one followed event. Unknown topics and payloads that don't fit are passed over. */
  return async (e: Pick<DomainEvent, 'topic' | 'payload'>): Promise<void> => {
    await dispatch(e);
  };
};
