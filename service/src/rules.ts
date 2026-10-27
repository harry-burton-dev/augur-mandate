import { ENDED, type Intent } from './store.ts';

/**
 * Who may see and do what with an intent. Every read and write goes through
 * these, so a later rule (a protective marking, say) is one more check here.
 *
 * Seeing comes in two depths. In **full** is the intent, its statement, its
 * bindings and its history. As a **summary** is its title, holder, life and
 * the holder's latest judgement: enough to see the shape of the tree around
 * your part without reading other teams' orders.
 *
 * - Anyone who can stand on an intent's floor sees it in full.
 * - Line of sight: whoever holds an intent, or any part below it, sees it in
 *   full, and so every intent above theirs to the root.
 * - A lead standing on the floor of an intent sees everything below it in full.
 * - Whoever sees an intent in full sees its children as summaries, so the
 *   parts beside yours show their title and judgement, not their statement.
 */

/** Who is looking: from the caller the gateway signed, and the principals identity says they stand for. */
export interface Viewer {
  id: string;
  name: string;
  principals: readonly string[];
  workspace: { id: string; kind: 'personal' | 'team' | 'org'; role: 'member' | 'lead' };
}

export type Sight = 'full' | 'summary';

/** They can stand on the intent's floor, or are standing on it now. Someone's own floor is only ever theirs. */
export const onFloorOf = (v: Viewer, i: Intent) => (i.floorKind !== 'personal' && v.workspace.id === i.workspace) || v.principals.includes(i.floor);

/** They hold it, or are on the team that does. Enough to read it; acting for the team takes a lead (`holds`). */
export const amongHolders = (v: Viewer, i: Intent) =>
  i.holder === `person:${v.id}` || (i.holder === 'floor' && (v.principals.includes(`team:${i.workspace}`) || (v.workspace.id === i.workspace && i.floorKind !== 'personal')));

/** They may act as its holder: the person it was passed to, or a lead standing on the floor that holds it. */
export const holds = (v: Viewer, i: Intent) =>
  i.holder === `person:${v.id}` || (i.holder === 'floor' && v.workspace.id === i.workspace && (v.workspace.role === 'lead' || i.floorKind === 'personal'));

/**
 * How far the viewer sees each intent of one tree (all of it, as `store.tree`
 * gives it). Intents they can't see aren't in the map.
 */
export const sightOf = (v: Viewer, tree: readonly Intent[]): Map<string, Sight> => {
  const byId = new Map(tree.map((i) => [i.id, i]));
  const full = new Set<string>();
  for (const i of tree) {
    const chain = [...i.ancestors.map((a) => byId.get(a)).filter((a): a is Intent => Boolean(a)), i];
    // Leads see down from their floor; the floor sees its own; holders see up from theirs.
    if (onFloorOf(v, i) || chain.some((a) => a.workspace === v.workspace.id && v.workspace.role === 'lead' && a.floorKind !== 'personal')) full.add(i.id);
    if (amongHolders(v, i)) for (const a of chain) full.add(a.id);
  }
  const sight = new Map<string, Sight>();
  for (const i of tree) {
    if (full.has(i.id)) sight.set(i.id, 'full');
    else if (i.parent && full.has(i.parent)) sight.set(i.id, 'summary');
  }
  return sight;
};

export const ended = (i: Intent) => ENDED.includes(i.life);

/** A part passed down whose parent has been revised since it was back-briefed: its holder confirms again. */
export const needsRecheck = (i: Intent, parent: Intent | undefined) =>
  Boolean(parent && i.life === 'active' && i.briefedParentVersion !== undefined && parent.version > i.briefedParentVersion);

/** The holder hasn't said how it's going for longer than its rhythm: since they last did, or since it last changed. */
export const assessmentDue = (i: Intent, now = Date.now()) =>
  i.life === 'active' && now - Date.parse(i.ratedAt ?? i.updatedAt) > i.rhythmDays * 24 * 60 * 60 * 1000;

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

export const rightsOn = (v: Viewer, i: Intent, parent: Intent | undefined): Rights => {
  const holder = holds(v, i) && !ended(i);
  const giver = (parent ? holds(v, parent) : holds(v, i)) && !ended(i);
  return {
    edit: holder && (i.life === 'draft' || i.life === 'active'),
    pass: holder && i.life === 'active' && i.floorKind !== 'personal',
    backBrief: holder && (i.life === 'passed' || needsRecheck(i, parent)),
    assess: holder && i.life === 'active',
    bind: holder && i.life !== 'passed',
    achieve: giver && i.life === 'active',
    withdraw: giver,
    mainEffort: Boolean(parent) && giver && !ended(i),
  };
};

/** Whether someone standing on this floor may set a new intent on it: its leads, or anyone on their own floor. */
export const maySet = (v: Viewer) => v.workspace.kind === 'personal' || v.workspace.role === 'lead';
