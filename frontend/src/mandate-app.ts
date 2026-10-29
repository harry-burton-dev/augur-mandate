import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { ago, type DialogSubmit, type ListItem, type SelectOption, type StatusName, type TreeItem } from '@augur/ui-kit';
import type { DocumentRef } from '@augur/mfe-sdk';
import {
  RATING_WORDS,
  ROLE_WORDS,
  pathFor,
  type Branch,
  type Detail,
  type EntityRef,
  type Floor,
  type FloorItem,
  type FloorKind,
  type MandateApi,
  type Place,
  type Rating,
  type Statement,
  type Summary,
  type Target,
  type Yours,
} from './api.js';

/** How a summary's state reads, as a mark and a word: where it is in its life, else how its holder judges it. */
export const markOf = (i: Pick<Summary, 'life' | 'rating'>): { status: StatusName; label: string } => {
  switch (i.life) {
    case 'draft':
      return { status: 'paused', label: 'Draft' };
    case 'passed':
      return { status: 'needs', label: 'Waiting for a back-brief' };
    case 'achieved':
      return { status: 'done', label: 'Achieved' };
    case 'superseded':
      return { status: 'done', label: 'Closed' };
    case 'withdrawn':
      return { status: 'paused', label: 'Withdrawn' };
  }
  switch (i.rating) {
    case 'at_risk':
      return { status: 'warning', label: 'At risk' };
    case 'blocked':
      return { status: 'failed', label: 'Blocked' };
    case 'achieved':
      return { status: 'done', label: 'Says achieved' };
    case 'on_track':
      return { status: 'running', label: 'On track' };
    default:
      return { status: 'queued', label: 'Under way' };
  }
};

/** Who holds it, in words. */
export const holderWords = (i: Pick<Summary, 'holder' | 'holderName' | 'floorName'>) =>
  i.holder === 'floor' ? `${i.holderName || i.floorName || 'This floor'}’s leads` : i.holderName || 'Someone';

/** The statement's parts, in the order allied orders give them, with what each asks for. */
export const PARTS: { key: Exclude<keyof Statement, 'keyTasks'> | 'keyTasks'; label: string; hint: string; required?: boolean }[] = [
  { key: 'mission', label: 'Mission', hint: 'One line: who does what, when and where.' },
  { key: 'purpose', label: 'Purpose', hint: 'Why: what it’s in order to achieve.', required: true },
  { key: 'endState', label: 'End state', hint: 'What done looks like, so anyone can tell.', required: true },
  { key: 'keyTasks', label: 'Key tasks', hint: 'What must be done for it to succeed. One a line.' },
  { key: 'constraints', label: 'Constraints', hint: 'What must be done, or kept to.' },
  { key: 'restraints', label: 'Restraints', hint: 'What must not be done.' },
  { key: 'freedoms', label: 'Freedoms', hint: 'What whoever holds it may decide for themselves.' },
];

const RATING_OPTIONS: SelectOption[] = (Object.keys(RATING_WORDS) as Rating[]).map((value) => ({ value, label: RATING_WORDS[value] }));
const ROLE_OPTIONS: SelectOption[] = Object.entries(ROLE_WORDS).map(([value, label]) => ({
  value,
  label,
  detail: { subject: 'What it’s about or acts on', resource: 'Put to the work', area: 'A place it’s bounded by', related: 'Worth knowing about' }[value],
}));

const FLOOR_COLOUR: Record<FloorKind, string> = { personal: 'var(--floor-you-high)', team: 'var(--floor-team-high)', org: 'var(--floor-org-high)' };

type Dialog = 'new' | 'edit' | 'pass' | 'accept' | 'concern' | 'assess' | 'achieve' | 'withdraw' | 'role';

/**
 * Mandate inside the shell: the floor's intents, what the person holds, and one
 * intent with its statement, line of sight, the parts below and what it's bound to.
 * Pickers and opening other apps' things come in as functions from the entry.
 *
 * @fires mandate-place - detail: the Place it moved to, for the address bar
 */
export class MandateApp extends LitElement {
  static override properties = {
    api: { attribute: false },
    floorName: { type: String, attribute: 'floor-name' },
    floorKind: { type: String, attribute: 'floor-kind' },
    place: { attribute: false },
    pickDocument: { attribute: false },
    pickEntity: { attribute: false },
    openDocument: { attribute: false },
    openEntity: { attribute: false },
    floor: { state: true },
    yours: { state: true },
    detail: { state: true },
    loading: { state: true },
    error: { state: true },
    dialog: { state: true },
    note: { state: true },
    targets: { state: true },
    picked: { state: true },
    noEntities: { state: true },
  };

  declare api: MandateApi;
  declare floorName: string;
  declare floorKind: FloorKind;
  declare place: Place;
  declare pickDocument: (() => Promise<DocumentRef>) | undefined;
  declare pickEntity: (() => Promise<EntityRef>) | undefined;
  declare openDocument: ((ref: DocumentRef) => void) | undefined;
  declare openEntity: ((ref: EntityRef) => void) | undefined;
  declare floor: Floor | undefined;
  declare yours: Yours | undefined;
  declare detail: Detail | undefined;
  declare loading: boolean;
  declare error: string;
  declare dialog: Dialog | undefined;
  declare note: string;
  declare targets: Target[];
  /** An entity picked in Data Atlas, waiting for its role. */
  declare picked: EntityRef | undefined;
  /** Why entities can't be bound yet, once asking found no app that picks them. */
  declare noEntities: string;

  constructor() {
    super();
    this.floorName = '';
    this.floorKind = 'personal';
    this.place = { view: 'floor' };
    this.loading = false;
    this.error = '';
    this.note = '';
    this.targets = [];
    this.noEntities = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.refresh();
  }

  /** Loads the rail, then whatever the place shows. */
  async refresh() {
    this.loading = true;
    this.error = '';
    try {
      [this.floor, this.yours] = await Promise.all([this.api.floor(), this.api.yours()]);
      if (this.place.view === 'intent') this.detail = await this.api.intent(this.place.id);
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  go(place: Place) {
    this.place = place;
    this.note = '';
    this.detail = place.view === 'intent' && this.detail?.intent.id === place.id ? this.detail : undefined;
    this.dispatchEvent(new CustomEvent('mandate-place', { detail: place, bubbles: true }));
    void this.refresh();
  }

  /** Runs a change to the open intent, shows what it answers, and refreshes the rail. Throws for a dialog to show. */
  private async change(run: () => Promise<Detail>, note = '') {
    this.detail = await run();
    this.note = note;
    [this.floor, this.yours] = await Promise.all([this.api.floor(), this.api.yours()]);
  }

  private act = async (run: () => Promise<Detail>, note = '') => {
    try {
      await this.change(run, note);
    } catch (err) {
      this.note = (err as Error).message;
    }
  };

  // ---- the rail ----

  private rail() {
    const floor = this.floor;
    const yours = this.yours;
    const waiting = (yours?.passed.length ?? 0) + (yours?.recheck.length ?? 0);
    const here: TreeItem[] = [
      { id: 'floor', label: 'Intent', icon: 'compass', ...(floor ? { meta: String(floor.intents.length) } : {}) },
      ...(floor?.drafts.length ? [{ id: 'drafts', label: 'Drafts', icon: 'document', meta: String(floor.drafts.length) }] : []),
    ];
    const selected = this.place.view === 'floor' ? 'floor' : '';
    return html`<nav class="mandate-rail" aria-label="Intent">
      <ui-tree label="On this floor" heading=${this.floorName || 'This floor'} .items=${here} selected=${selected} @ui-select=${() => this.go({ view: 'floor' })}></ui-tree>
      ${floor?.can.create ? html`<div class="mandate-rail-act"><ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'new')}>New intent</ui-button></div>` : nothing}
      <ui-tree
        label="For you"
        heading="For you"
        .items=${[{ id: 'yours', label: 'What you hold', icon: 'inbox', ...(waiting ? { meta: String(waiting) } : {}) }] satisfies TreeItem[]}
        selected=${this.place.view === 'yours' ? 'yours' : ''}
        @ui-select=${() => this.go({ view: 'yours' })}
      ></ui-tree>
    </nav>`;
  }

  // ---- a floor ----

  private card(i: FloorItem | Summary, counts?: FloorItem['counts']) {
    const mark = markOf(i);
    return html`<button class="mandate-card" style=${`--floor:${FLOOR_COLOUR[i.floorKind]}`} @click=${() => this.go({ view: 'intent', id: i.id })}>
      <span class="mandate-card-top">
        <span class="mandate-card-title">${i.title}</span>
        <ui-status status=${mark.status} label=${mark.label}></ui-status>
      </span>
      <span class="mandate-card-meta">${[i.partOf ? `Part of ${i.partOf}` : '', holderWords(i), i.byDate ? `By ${i.byDate}` : ''].filter(Boolean).join(' · ')}</span>
      ${counts?.parts
        ? html`<span class="mandate-card-meta">${counts.parts} ${counts.parts === 1 ? 'part' : 'parts'} below${counts.atRisk ? html` · <b class="at-risk">${counts.atRisk} at risk</b>` : nothing}${counts.blocked
            ? html` · <b class="blocked">${counts.blocked} blocked</b>`
            : nothing}</span>`
        : nothing}
      ${i.ratingNote ? html`<span class="mandate-card-note">${i.ratingNote}</span>` : nothing}
    </button>`;
  }

  private floorView() {
    const floor = this.floor;
    if (!floor) return html`<ui-state kind="loading" heading="Loading this floor’s intent"></ui-state>`;
    const empty = !floor.intents.length && !floor.drafts.length;
    return html`<ui-heading eyebrow=${this.floorName || 'This floor'} heading="Intent" size="l"
        summary=${floor.intents.length ? `${floor.intents.length} under way here.` : 'Nothing under way here yet.'}></ui-heading>
      ${empty
        ? html`<ui-state kind="empty" heading=${floor.can.create ? 'Set the first intent for this floor' : 'No intent on this floor yet'}
            body=${floor.can.create
              ? 'Say what this floor means to achieve and why. Then pass parts of it down to the teams and people who’ll do it.'
              : 'When this floor’s leads set intent, or pass part of theirs down to you, it shows here.'}
            action=${floor.can.create ? 'New intent' : ''} @ui-action=${() => (this.dialog = 'new')}></ui-state>`
        : nothing}
      ${floor.intents.length ? html`<div class="mandate-cards">${floor.intents.map((i) => this.card(i, i.counts))}</div>` : nothing}
      ${floor.drafts.length ? html`<h3 class="mandate-sub">Drafts</h3><div class="mandate-cards">${floor.drafts.map((i) => this.card(i))}</div>` : nothing}
      ${floor.closed.length ? html`<h3 class="mandate-sub">Closed</h3><div class="mandate-cards">${floor.closed.map((i) => this.card(i))}</div>` : nothing}`;
  }

  // ---- what you hold ----

  private yoursView() {
    const yours = this.yours;
    if (!yours) return html`<ui-state kind="loading" heading="Loading what you hold"></ui-state>`;
    const row = (i: Summary, status: StatusName, detail: string): ListItem => ({ id: i.id, title: i.title, detail, status, ...(i.byDate ? { meta: `By ${i.byDate}` } : {}) });
    const items: ListItem[] = [
      ...yours.passed.map((i) => ({ ...row(i, 'needs', `${i.partOf ? `Part of ${i.partOf} · ` : ''}Say it back to accept it`), group: 'Passed to you' })),
      ...yours.recheck.map((i) => ({ ...row(i, 'needs', `${i.partOf} has changed: check yours still fits`), group: 'Passed to you' })),
      ...yours.due.map((i) => ({ ...row(i, 'needs', 'How is it going?'), group: 'Needs your judgement' })),
      ...yours.holding
        .filter((i) => !yours.due.some((d) => d.id === i.id) && !yours.recheck.some((d) => d.id === i.id))
        .map((i) => ({ ...row(i, markOf(i).status, [i.partOf ? `Part of ${i.partOf}` : '', i.floorName, markOf(i).label].filter(Boolean).join(' · ')), group: 'You hold' })),
    ];
    return html`<ui-heading eyebrow="For you" heading="What you hold" size="l"
        summary=${yours.passed.length ? `${yours.passed.length} waiting for your back-brief.` : 'Your parts, on every floor.'}></ui-heading>
      <ui-list label="What you hold" .noun=${['intent', 'intents']} .items=${items} empty="Nothing passed to you yet. When someone passes you part of their intent, it shows here."
        @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.go({ view: 'intent', id: e.detail.item.id })}></ui-list>`;
  }

  // ---- one intent ----

  private branch(b: Branch): TemplateResult {
    const mark = markOf(b);
    const label = html`<span class="mandate-branch-title">${b.mainEffort ? html`<span class="mandate-badge" title="Main effort">Main effort</span>` : nothing}${b.title}</span>
      <span class="mandate-card-meta">${holderWords(b)}${b.floorKind === 'team' ? ` · ${b.floorName}` : ''}${b.ratingNote ? ` · ${b.ratingNote}` : ''}</span>`;
    return html`<li class="mandate-branch" style=${`--floor:${FLOOR_COLOUR[b.floorKind]}`}>
      <div class="mandate-branch-row">
        ${b.sight === 'full'
          ? html`<button class="mandate-branch-open" @click=${() => this.go({ view: 'intent', id: b.id })}>${label}</button>`
          : html`<div class="mandate-branch-open" title="You see its title and how it’s going, not its statement">${label}</div>`}
        <ui-status status=${mark.status} label=${mark.label}></ui-status>
        ${this.detail?.can.pass && b.life !== 'withdrawn' ? this.mainEffortToggle(b) : nothing}
      </div>
      ${b.below.length ? html`<ul class="mandate-tree">${b.below.map((c) => this.branch(c))}</ul>` : nothing}
    </li>`;
  }

  private mainEffortToggle(b: Branch) {
    const ownChild = b.parent === this.detail?.intent.id;
    if (!ownChild) return nothing;
    return html`<ui-button kind="ghost" size="sm" @click=${() => this.act(() => this.api.mainEffort(b.id, !b.mainEffort).then(() => this.api.intent(this.detail!.intent.id)))}>
      ${b.mainEffort ? 'Clear main effort' : 'Main effort'}</ui-button>`;
  }

  private statement(s: Statement) {
    const parts = PARTS.filter((p) => (p.key === 'keyTasks' ? s.keyTasks.length : s[p.key]));
    if (!parts.length) return html`<p class="mandate-quiet">Nothing written yet.</p>`;
    return html`<dl class="mandate-statement">
      ${parts.map(
        (p) => html`<div><dt>${p.label}</dt><dd>${p.key === 'keyTasks' ? html`<ul>${s.keyTasks.map((t) => html`<li>${t}</li>`)}</ul>` : s[p.key]}</dd></div>`,
      )}
    </dl>`;
  }

  private intentView() {
    const d = this.detail;
    if (!d) return html`<ui-state kind="loading" heading="Loading the intent"></ui-state>`;
    const { intent, can } = d;
    const mark = markOf(intent);
    const latest = d.assessments[0];
    const byRole = Object.keys(ROLE_WORDS)
      .map((role) => ({ role, items: d.entities.filter((e) => e.role === role) }))
      .filter((g) => g.items.length);
    const meta = [
      intent.floorName,
      `held by ${holderWords(intent)}`,
      d.passed ? `passed down by ${d.passed.by}` : '',
      d.issued ? `version ${d.issued.version}, issued ${ago(d.issued.at)}` : 'not issued yet',
      intent.byDate ? `by ${intent.byDate}` : '',
    ].filter(Boolean);
    // Ready to issue once the draft says why and what done looks like.
    const draft = d.draft ?? d.statement;
    const written = Boolean(draft.purpose.trim() && draft.endState.trim());
    return html`
      ${d.lineOfSight.length
        ? html`<ol class="mandate-trail" aria-label="The intent above this one">
            ${d.lineOfSight.map((a) => html`<li><button class="mandate-crumb" @click=${() => this.go({ view: 'intent', id: a.id })}>${a.title}</button><span aria-hidden="true">›</span></li>`)}
          </ol>`
        : nothing}
      <div class="mandate-head">
        <ui-heading eyebrow=${intent.mainEffort ? 'Main effort' : intent.parent ? 'Part' : 'Intent'} heading=${intent.title} size="l" summary=${meta.join(' · ')}></ui-heading>
        <ui-status status=${mark.status} label=${mark.label}></ui-status>
      </div>
      ${this.attention(d)}
      <div class="mandate-actions">
        ${can.backBrief && intent.life === 'passed' ? html`<ui-button kind="primary" @click=${() => (this.dialog = 'accept')}>Back-brief</ui-button>` : nothing}
        ${can.backBrief && intent.life === 'passed' ? html`<ui-button kind="secondary" @click=${() => (this.dialog = 'concern')}>Raise a concern</ui-button>` : nothing}
        ${can.backBrief && d.recheck ? html`<ui-button kind="primary" @click=${() => (this.dialog = 'accept')}>Confirm it still stands</ui-button>` : nothing}
        ${can.edit ? html`<ui-button kind=${intent.life === 'draft' && !written ? 'primary' : 'secondary'} @click=${() => (this.dialog = 'edit')}>${intent.life === 'draft' ? 'Write it' : 'Revise'}</ui-button>` : nothing}
        ${can.edit && this.unissued(d) ? html`<ui-button kind=${written ? 'primary' : 'secondary'} @click=${() => this.act(() => this.api.issue(intent.id), 'Issued.')}>Issue</ui-button>` : nothing}
        ${can.assess ? html`<ui-button kind=${d.assessmentDue ? 'primary' : 'secondary'} @click=${() => (this.dialog = 'assess')}>How is it going?</ui-button>` : nothing}
        ${can.pass ? html`<ui-button kind="secondary" @click=${() => this.openPass()}>Pass down</ui-button>` : nothing}
        ${can.achieve ? html`<ui-button kind="secondary" @click=${() => (this.dialog = 'achieve')}>Close as achieved</ui-button>` : nothing}
        ${can.withdraw ? html`<ui-button kind="ghost" @click=${() => (this.dialog = 'withdraw')}>Withdraw</ui-button>` : nothing}
      </div>
      <p class="mandate-note" role="status">${this.note}</p>
      <div class="mandate-columns">
        <div class="mandate-col">
          ${this.statement(d.statement)}
          ${latest
            ? html`<section class="mandate-pane"><h3 class="mandate-label">Latest judgement · ${latest.byName} · ${ago(latest.at)}</h3>
                <p><b>${RATING_WORDS[latest.rating]}.</b> ${latest.note}</p></section>`
            : nothing}
          <section>
            <h3 class="mandate-label">Passed down</h3>
            ${d.below.length ? html`<ul class="mandate-tree mandate-tree-top">${d.below.map((b) => this.branch(b))}</ul>` : html`<p class="mandate-quiet">${can.pass ? 'Nothing passed down yet. Pass parts of it to the teams below, or to people on this floor.' : 'Nothing passed down.'}</p>`}
          </section>
        </div>
        <aside class="mandate-side">
          ${d.lineOfSight.length
            ? html`<section>
                <h3 class="mandate-label">Line of sight</h3>
                <ol class="mandate-sight">
                  ${d.lineOfSight.map((a) => html`<li style=${`--floor:${FLOOR_COLOUR[a.floorKind]}`}><b>${a.title}</b><span>${a.purpose || a.mission}</span></li>`)}
                  <li style=${`--floor:${FLOOR_COLOUR[intent.floorKind]}`}><b>This</b></li>
                </ol>
              </section>`
            : nothing}
          <section>
            <h3 class="mandate-label">Bound to</h3>
            ${byRole.length
              ? byRole.map(
                  (g) => html`<div class="mandate-role"><span class="mandate-quiet">${ROLE_WORDS[g.role] ?? g.role}</span><span class="mandate-chips">${g.items.map(
                    (e) => html`<span class="mandate-chip">
                      <button class="mandate-crumb" title=${e.from ? `From ${e.from}` : `Open in Data Atlas`} @click=${() => this.openEntity?.(e.entity)}>${e.entity.label || 'An entity'}</button>
                      ${can.bind && !e.from
                        ? html`<button class="mandate-crumb mandate-unbind" aria-label=${`Unbind ${e.entity.label || 'this entity'}`} @click=${() => this.act(() => this.api.unbindEntity(intent.id, e.entity.id, e.role))}>×</button>`
                        : nothing}
                    </span>`,
                  )}</span></div>`,
                )
              : html`<p class="mandate-quiet">No entities yet: the ships, places and resources it’s about.</p>`}
            ${can.bind
              ? html`<ui-button kind="ghost" size="sm" ?disabled=${Boolean(this.noEntities)} reason=${this.noEntities} @click=${() => void this.bindEntity()}>Bind an entity</ui-button>`
              : nothing}
          </section>
          <section>
            <h3 class="mandate-label">Context documents</h3>
            ${d.documents.length
              ? html`<ul class="mandate-docs">${d.documents.map(
                  (doc) => html`<li>
                    <button class="mandate-crumb" @click=${() => this.openDocument?.(doc.document)}>${doc.document.title}</button>
                    <span class="mandate-quiet">${doc.from ? `from ${doc.from}` : ''}</span>
                    ${can.bind && !doc.from ? html`<ui-button kind="ghost" size="sm" @click=${() => this.act(() => this.api.removeDocument(intent.id, doc.document))}>Remove</ui-button>` : nothing}
                  </li>`,
                )}</ul>`
              : html`<p class="mandate-quiet">No documents yet.</p>`}
            ${can.bind && this.pickDocument ? html`<ui-button kind="ghost" size="sm" @click=${() => void this.addDocument()}>Add a document</ui-button>` : nothing}
          </section>
          <section>
            <h3 class="mandate-label">History</h3>
            <ul class="mandate-history">${this.history(d)}</ul>
          </section>
        </aside>
      </div>`;
  }

  /** The draft differs from what was last issued, or nothing has been yet. */
  private unissued(d: Detail) {
    if (!d.draft) return false;
    if (!d.issued) return true;
    return JSON.stringify(d.draft) !== JSON.stringify(d.statement) || d.versions[0]?.title !== d.intent.title;
  }

  /** What this intent needs from the person now, said once at the top. */
  private attention(d: Detail) {
    const { intent, can } = d;
    let words = '';
    if (can.backBrief && intent.life === 'passed') words = `${d.passed?.by ?? 'Someone'} passed you this. Read the line of sight, then say it back in your own words to accept it.`;
    else if (can.backBrief && d.recheck) words = `${d.lineOfSight.at(-1)?.title ?? 'The intent above'} has changed since you back-briefed. Check yours still fits.`;
    else if (can.edit && intent.life === 'draft') words = 'A draft: say its purpose and end state, then issue it.';
    else if (can.edit && this.unissued(d)) words = 'You’ve changed it since it was last issued. Issue it to make it the next version.';
    else if (d.assessmentDue) words = 'How is it going? Your last judgement is older than its rhythm.';
    else if (d.ended) words = `${markOf(intent).label} ${ago(d.ended.at)}.${d.ended.reason ? ` ${d.ended.reason}` : ''}`;
    return words ? html`<p class="mandate-attention">${words}</p>` : nothing;
  }

  private history(d: Detail) {
    const lines = [
      ...d.versions.map((v) => ({ at: v.at, words: `Version ${v.version} issued by ${v.by}` })),
      ...d.backBriefs.map((b) => ({ at: b.at, words: b.outcome === 'accepted' ? `${b.byName} back-briefed: “${b.words}”` : `${b.byName} raised a concern: “${b.concern}”` })),
      ...d.assessments.map((a) => ({ at: a.at, words: `${a.byName}: ${RATING_WORDS[a.rating]}${a.note ? `, “${a.note}”` : ''}` })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return lines.slice(0, 12).map((l) => html`<li><span class="mandate-quiet">${ago(l.at)}</span> ${l.words}</li>`);
  }

  // ---- binding ----

  private async bindEntity() {
    if (!this.pickEntity) return;
    try {
      this.picked = await this.pickEntity();
      this.dialog = 'role';
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === 'IntentCancelled') return;
      // Explain, never hide: the control stays, saying why it can't be used yet.
      this.noEntities = 'Linking to entities arrives with Data Atlas.';
    }
  }

  private async addDocument() {
    if (!this.pickDocument || !this.detail) return;
    const id = this.detail.intent.id;
    try {
      const doc = await this.pickDocument();
      await this.act(() => this.api.addDocument(id, doc));
    } catch (err) {
      if ((err as Error).name === 'IntentCancelled') return;
      this.note = (err as Error).message;
    }
  }

  // ---- dialogs ----

  private async openPass() {
    this.targets = [];
    this.dialog = 'pass';
    await this.findTargets('');
  }

  private async findTargets(q: string) {
    if (!this.detail) return;
    try {
      const found = await this.api.targets(this.detail.intent.id, q);
      this.targets = [...found.teams, ...found.people];
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private submitNew: DialogSubmit = async (values) => {
    const made = await this.api.create(values.title, this.floorName);
    this.go({ view: 'intent', id: made.id });
    this.dialog = 'edit';
  };

  private submitEdit: DialogSubmit = async (values) => {
    const d = this.detail!;
    const statement: Partial<Statement> = {};
    for (const p of PARTS) {
      if (p.key === 'keyTasks') statement.keyTasks = (values.keyTasks ?? '').split('\n');
      else statement[p.key] = values[p.key] ?? '';
    }
    await this.change(() => this.api.edit(d.intent.id, { title: values.title, statement, byDate: values.byDate?.trim() || null }), 'Saved. Issue it when it’s ready.');
  };

  private submitPass: DialogSubmit = async (values) => {
    const d = this.detail!;
    const carry = (values.carry ?? '').split(',').filter(Boolean);
    await this.api.pass(d.intent.id, {
      to: values.to,
      title: values.title,
      ...(values.purpose?.trim() ? { purpose: values.purpose } : {}),
      ...(values.byDate?.trim() ? { byDate: values.byDate.trim() } : {}),
      carry: { entities: carry.filter((c) => c.startsWith('e|')).map((c) => c.slice(2)), documents: carry.filter((c) => c.startsWith('d|')).map((c) => c.slice(2)) },
    });
    await this.change(() => this.api.intent(d.intent.id), 'Passed down. It’s under way once they back-brief it.');
  };

  private submitAccept: DialogSubmit = async (values) => {
    await this.change(() => this.api.backBrief(this.detail!.intent.id, { words: values.words, outcome: 'accepted' }), 'Accepted. It’s yours.');
  };

  private submitConcern: DialogSubmit = async (values) => {
    await this.change(() => this.api.backBrief(this.detail!.intent.id, { words: values.words, concern: values.concern, outcome: 'concern' }), 'Sent back with your concern.');
  };

  private submitAssess: DialogSubmit = async (values) => {
    await this.change(() => this.api.assess(this.detail!.intent.id, values.rating as Rating, values.note ?? ''), 'Thanks. Whoever passed it down sees it.');
  };

  private submitAchieve: DialogSubmit = async () => {
    await this.change(() => this.api.achieve(this.detail!.intent.id), 'Closed as achieved.');
  };

  private submitWithdraw: DialogSubmit = async (values) => {
    await this.change(() => this.api.withdraw(this.detail!.intent.id, values.reason ?? ''), 'Withdrawn.');
  };

  private submitRole: DialogSubmit = async (values) => {
    const picked = this.picked!;
    await this.change(() => this.api.bindEntity(this.detail!.intent.id, picked, values.role));
    this.picked = undefined;
  };

  private dialogs() {
    const close = () => {
      this.dialog = undefined;
    };
    const d = this.detail;
    switch (this.dialog) {
      case 'new':
        return html`<ui-dialog open eyebrow=${this.floorName || 'This floor'} heading="New intent"
            summary=${this.floorKind === 'personal' ? 'Only you see intent on your own floor.' : 'Everyone on this floor will read it once it’s issued. Its leads hold it.'}
            action-label="Start writing" busy-label="Making…" .submit=${this.submitNew} @ui-close=${close}>
            <ui-text-field slot="fields" name="title" label="Name" hint="What people will call it: Operation Alpha, Winter readiness." required maxlength="140"></ui-text-field>
          </ui-dialog>`;
      case 'edit': {
        if (!d?.draft) return nothing;
        const s = d.draft;
        return html`<ui-dialog open size="read" eyebrow=${d.intent.floorName} heading=${d.intent.life === 'draft' ? 'Write the intent' : 'Revise the intent'}
            summary=${d.intent.version ? 'Saving keeps it as a draft. Issue it to make it the next version; the parts below are asked to check theirs still fits.' : 'Purpose and end state are needed to issue it.'}
            action-label="Save" busy-label="Saving…" .submit=${this.submitEdit} @ui-close=${close}>
            <ui-text-field slot="fields" name="title" label="Name" required maxlength="140" .value=${d.intent.title}></ui-text-field>
            ${PARTS.map(
              (p) => html`<ui-text-field slot="fields" name=${p.key} label=${p.label} hint=${p.hint} ?optional=${!p.required} multiline rows=${p.key === 'mission' ? 2 : 3}
                maxlength=${p.key === 'mission' ? 500 : 2000} .value=${p.key === 'keyTasks' ? s.keyTasks.join('\n') : s[p.key]}></ui-text-field>`,
            )}
            <ui-text-field slot="fields" name="byDate" label="Done by" hint="YYYY-MM-DD" optional maxlength="10" .value=${d.intent.byDate ?? ''}
              .validate=${(v: string) => (!v.trim() || /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? '' : 'Write it as 2026-11-20.')}></ui-text-field>
          </ui-dialog>`;
      }
      case 'pass': {
        if (!d) return nothing;
        const carry: SelectOption[] = [
          ...d.entities.map((e) => ({ value: `e|${e.entity.id}|${e.role}`, label: e.entity.label || 'An entity', detail: ROLE_WORDS[e.role] ?? e.role })),
          ...d.documents.map((x) => ({ value: `d|${x.document.app}|${x.document.id}`, label: x.document.title, detail: 'Document' })),
        ];
        return html`<ui-dialog open size="read" eyebrow=${`Pass down from ${d.intent.title}`} heading="Who holds this part?"
            summary="A team directly below this floor, or someone on it. They say it back in their own words before it’s under way."
            action-label="Pass down" busy-label="Passing…" .submit=${this.submitPass} @ui-close=${close}>
            <ui-text-field slot="fields" name="find" label="Find a team or person" optional maxlength="100"
              @ui-input=${(e: CustomEvent<{ value: string }>) => void this.findTargets(e.detail.value)}></ui-text-field>
            <ui-select slot="fields" name="to" label="To" required placeholder="Choose who"
              .options=${this.targets.map((t) => ({ value: t.to, label: t.you ? `${t.name} (you)` : t.name, detail: t.to.startsWith('team:') ? 'Team' : (t.email ?? '') }))}></ui-select>
            <ui-text-field slot="fields" name="title" label="Their part" hint="What they’re to achieve, in a line." required maxlength="140"></ui-text-field>
            <ui-text-field slot="fields" name="purpose" label="Why it matters to the whole" optional multiline rows="2" maxlength="2000"></ui-text-field>
            <ui-text-field slot="fields" name="byDate" label="Done by" hint="YYYY-MM-DD" optional maxlength="10"
              .validate=${(v: string) => (!v.trim() || /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? '' : 'Write it as 2026-11-20.')}></ui-text-field>
            ${carry.length ? html`<ui-checkbox-group slot="fields" name="carry" label="Carry down" hint="What their part starts bound to." optional .options=${carry}></ui-checkbox-group>` : nothing}
          </ui-dialog>`;
      }
      case 'accept':
        return d
          ? html`<ui-dialog open size="read" eyebrow=${d.recheck ? 'Confirm your back-brief' : 'Back-brief'} heading=${d.intent.title}
              summary=${d.lineOfSight.length ? `Part of ${d.lineOfSight.at(-1)!.title}: ${d.lineOfSight.at(-1)!.purpose || d.lineOfSight.at(-1)!.endState}` : ''}
              action-label=${d.recheck ? 'It still stands' : 'Accept this part'} busy-label="Sending…" .submit=${this.submitAccept} @ui-close=${close}>
              <ui-text-field slot="fields" name="words" label="Say it back in your own words" hint="What you’ll achieve, and why it matters to the whole." required multiline rows="4" maxlength="4000"></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'concern':
        return d
          ? html`<ui-dialog open size="read" eyebrow="Raise a concern" heading=${d.intent.title} summary="It goes back to whoever passed it down, who can revise it or answer."
              action-label="Send it back" busy-label="Sending…" .submit=${this.submitConcern} @ui-close=${close}>
              <ui-text-field slot="fields" name="words" label="Say it back in your own words" required multiline rows="3" maxlength="4000"></ui-text-field>
              <ui-text-field slot="fields" name="concern" label="What doesn’t fit" required multiline rows="3" maxlength="4000"></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'assess':
        return d
          ? html`<ui-dialog open eyebrow=${d.intent.title} heading="How is it going?" summary="Against its end state. Whoever passed it down sees this."
              action-label="Say so" busy-label="Saving…" .submit=${this.submitAssess} @ui-close=${close}>
              <ui-select slot="fields" name="rating" label="It’s" required .options=${RATING_OPTIONS} .value=${d.intent.rating ?? ''}></ui-select>
              <ui-text-field slot="fields" name="note" label="Why" optional multiline rows="2" maxlength="1000"></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'achieve':
        return d
          ? html`<ui-dialog open eyebrow=${d.intent.title} heading="Close it as achieved?" summary="Anything still open below it closes with it."
              action-label="Close as achieved" busy-label="Closing…" .submit=${this.submitAchieve} @ui-close=${close}></ui-dialog>`
          : nothing;
      case 'withdraw':
        return d
          ? html`<ui-dialog open danger eyebrow=${d.intent.title} heading="Withdraw it?" summary="Every part still open below it is withdrawn too, and its holders are told."
              action-label="Withdraw" busy-label="Withdrawing…" .submit=${this.submitWithdraw} @ui-close=${close}>
              <ui-text-field slot="fields" name="reason" label="Why" optional multiline rows="2" maxlength="1000"></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'role':
        return this.picked
          ? html`<ui-dialog open eyebrow=${this.picked.label} heading="What part does it play?" action-label="Bind it" busy-label="Binding…" .submit=${this.submitRole}
              @ui-close=${() => {
                this.picked = undefined;
                close();
              }}>
              <ui-select slot="fields" name="role" label="Role" required .options=${ROLE_OPTIONS} value="subject"></ui-select>
            </ui-dialog>`
          : nothing;
      default:
        return nothing;
    }
  }

  private main() {
    if (this.error) return html`<ui-state kind="error" heading="Couldn’t load Mandate" body=${this.error} action="Try again" @ui-action=${() => void this.refresh()}></ui-state>`;
    switch (this.place.view) {
      case 'yours':
        return this.yoursView();
      case 'intent':
        return this.intentView();
      default:
        return this.floorView();
    }
  }

  override render() {
    return html`<style>
        /* Mandate's own ground: the shell's water stays outside the app. */
        mandate-app { display: grid; grid-template-columns: minmax(200px, 260px) 1fr; min-height: 100%; background: var(--slate); }
        mandate-app .mandate-rail { display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-6) var(--space-3); border-right: 1px solid var(--hairline); }
        mandate-app .mandate-rail-act { padding: 0 var(--space-2); }
        mandate-app .mandate-main { min-width: 0; padding: var(--space-6) var(--edge); }
        mandate-app .mandate-main-inner { max-width: var(--measure-wide); display: flex; flex-direction: column; gap: var(--space-5); }
        mandate-app .mandate-main-inner[aria-busy='true'] { opacity: 0.7; }
        mandate-app .mandate-sub, mandate-app .mandate-label { margin: 0; font-size: var(--type-meta); font-weight: 400; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); }
        mandate-app .mandate-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-4); }
        mandate-app .mandate-card { all: unset; box-sizing: border-box; cursor: pointer; display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4) var(--space-5);
          border: 1px solid var(--hairline); border-left: 3px solid var(--floor); border-radius: var(--radius-card); background: var(--surface-pane); }
        mandate-app .mandate-card:hover { border-color: var(--hairline-strong); border-left-color: var(--floor); }
        mandate-app .mandate-card:focus-visible, mandate-app .mandate-crumb:focus-visible, mandate-app .mandate-branch-open:focus-visible { outline: 1.5px solid var(--focus); outline-offset: 2px; }
        mandate-app .mandate-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
        mandate-app .mandate-card-title { font-size: var(--type-lead); color: var(--ink); }
        mandate-app .mandate-card-meta, mandate-app .mandate-quiet { font-size: var(--type-small); color: var(--ink-muted); margin: 0; }
        mandate-app .mandate-card-note { font-size: var(--type-small); color: var(--ink); }
        mandate-app .at-risk { color: var(--warning); font-weight: 600; }
        mandate-app .blocked { color: var(--danger); font-weight: 600; }
        mandate-app .mandate-trail { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; font-size: var(--type-small); color: var(--ink-muted); }
        mandate-app .mandate-trail li { display: flex; gap: var(--space-2); }
        mandate-app .mandate-crumb { all: unset; cursor: pointer; color: var(--ink); border-radius: var(--radius-key); }
        mandate-app .mandate-crumb:hover { text-decoration: underline; }
        mandate-app .mandate-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
        mandate-app .mandate-attention { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius-inset); background: var(--surface-raised); border: 1px solid var(--hairline-strong); }
        mandate-app .mandate-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
        mandate-app .mandate-note { margin: 0; min-height: 1.5em; font-size: var(--type-small); color: var(--ink-muted); }
        mandate-app .mandate-columns { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(240px, 1fr); gap: var(--space-7); align-items: start; }
        @media (max-width: 960px) { mandate-app .mandate-columns { grid-template-columns: minmax(0, 1fr); } }
        mandate-app .mandate-col, mandate-app .mandate-side { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
        mandate-app .mandate-side { padding: var(--space-5); border-radius: var(--radius-card); background: var(--surface-inset); border: 1px solid var(--hairline); }
        mandate-app .mandate-side section, mandate-app .mandate-col section { display: flex; flex-direction: column; gap: var(--space-3); }
        mandate-app .mandate-statement { margin: 0; display: flex; flex-direction: column; gap: var(--space-5); max-width: var(--measure-prose); }
        mandate-app .mandate-statement dt { font-size: var(--type-meta); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin-bottom: var(--space-1); }
        mandate-app .mandate-statement dd { margin: 0; white-space: pre-line; }
        mandate-app .mandate-statement ul { margin: 0; padding-left: 1.2em; }
        mandate-app .mandate-pane { padding: var(--space-4); border-radius: var(--radius-inset); background: var(--surface-raised); }
        mandate-app .mandate-pane p { margin: 0; }
        mandate-app .mandate-tree { list-style: none; margin: 0; padding: 0 0 0 var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); border-left: 1px solid var(--hairline); }
        mandate-app .mandate-tree-top { padding-left: 0; border-left: 0; }
        mandate-app .mandate-branch { display: flex; flex-direction: column; gap: var(--space-2); }
        mandate-app .mandate-branch-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-inset);
          background: var(--surface-pane); border: 1px solid var(--hairline); border-left: 3px solid var(--floor); }
        mandate-app .mandate-branch-open { all: unset; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
        mandate-app button.mandate-branch-open { cursor: pointer; }
        mandate-app .mandate-branch-title { color: var(--ink); }
        mandate-app .mandate-badge { font-size: var(--type-meta); letter-spacing: 0.1em; text-transform: uppercase; color: var(--floor-team-high); margin-right: var(--space-2); }
        mandate-app .mandate-sight { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
        mandate-app .mandate-sight li { display: flex; flex-direction: column; gap: var(--space-1); padding-left: var(--space-3); border-left: 3px solid var(--floor); font-size: var(--type-small); }
        mandate-app .mandate-sight span { color: var(--ink-muted); }
        mandate-app .mandate-role { display: flex; flex-direction: column; gap: var(--space-2); }
        mandate-app .mandate-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
        mandate-app .mandate-chip { display: inline-flex; gap: var(--space-2); align-items: center; padding: var(--space-1) var(--space-3); border: 1px solid var(--hairline); border-radius: var(--radius-key); font-size: var(--type-small); }
        mandate-app .mandate-unbind { color: var(--ink-muted); }
        mandate-app .mandate-docs, mandate-app .mandate-history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--type-small); }
        mandate-app .mandate-docs li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
      </style>
      ${this.rail()}
      <main class="mandate-main"><div class="mandate-main-inner" aria-busy=${this.loading ? 'true' : 'false'}>${this.main()}</div></main>
      ${this.dialogs()}`;
  }
}

if (!customElements.get('mandate-app')) customElements.define('mandate-app', MandateApp);

declare global {
  interface HTMLElementTagNameMap {
    'mandate-app': MandateApp;
  }
}

export { pathFor };
