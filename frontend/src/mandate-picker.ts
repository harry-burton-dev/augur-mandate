import { LitElement, html } from 'lit';
import type { ListItem } from '@augur/ui-kit';
import type { IntentRef, MandateApi } from './api.js';

interface Pickable {
  id: string;
  title: string;
  detail: string;
}

/**
 * Mandate answering `aim.pick` for another app: an intent under way on this
 * floor or held by the person, or one found by the words of its title. A
 * briefing tool asks this to bound what it gathers to one intent and its tree.
 *
 * @fires mandate-picked - detail `{ intent: IntentRef }`
 * @fires mandate-cancel - the person closed it without picking
 */
export class MandatePicker extends LitElement {
  static override properties = {
    api: { attribute: false },
    purpose: { type: String },
    query: { state: true },
    intents: { state: true },
    loading: { state: true },
    failure: { state: true },
  };

  declare api: MandateApi;
  declare purpose: string;
  declare query: string;
  declare intents: Pickable[];
  declare loading: boolean;
  declare failure: string;

  private timer?: ReturnType<typeof setTimeout>;
  private asked = 0;

  constructor() {
    super();
    this.purpose = '';
    this.query = '';
    this.intents = [];
    this.loading = true;
    this.failure = '';
  }

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.list();
  }

  /** What's typed, or else what's under way here and what the person holds. */
  private async list() {
    const asked = ++this.asked;
    this.loading = true;
    this.failure = '';
    try {
      const q = this.query.trim();
      let intents: Pickable[];
      if (q) intents = (await this.api.search(q)).results;
      else {
        const [floor, yours] = await Promise.all([this.api.floor(), this.api.yours()]);
        const seen = new Set<string>();
        intents = [...floor.intents.map((i) => ({ i, where: 'On this floor' })), ...yours.holding.map((i) => ({ i, where: 'You hold' }))]
          .filter(({ i }) => !seen.has(i.id) && seen.add(i.id))
          .map(({ i, where }) => ({ id: i.id, title: i.title, detail: [where, i.partOf ? `Part of ${i.partOf}` : '', i.floorName].filter(Boolean).join(' · ') }));
      }
      if (asked === this.asked) this.intents = intents;
    } catch (err) {
      if (asked === this.asked) this.failure = (err as Error).message;
    } finally {
      if (asked === this.asked) this.loading = false;
    }
  }

  private search(q: string) {
    this.query = q;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.list(), 200);
  }

  private emit(name: string, detail: object = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  override render() {
    const rows: ListItem[] = this.intents.map((i) => ({ id: i.id, title: i.title, detail: i.detail, icon: 'compass' }));
    return html`<style>
        mandate-picker { display: flex; flex-direction: column; gap: var(--space-5); min-width: min(40rem, 100%); }
      </style>
      <ui-heading eyebrow="Pick from Mandate" heading=${this.purpose || 'Pick an intent'} summary="One under way here or that you hold, or find one by its title."></ui-heading>
      <ui-text-field label="Find" placeholder="Words in its title" .value=${this.query} @ui-input=${(e: CustomEvent<{ value: string }>) => this.search(e.detail.value)}></ui-text-field>
      <ui-list label="Intents to pick from" density="compact" .noun=${['intent', 'intents']} .items=${rows} ?loading=${this.loading} error=${this.failure}
        empty=${this.query.trim() ? 'Nothing you can read matches that.' : 'Nothing under way here, and nothing you hold. Type to find one anywhere you can read.'}
        @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
          const i = this.intents.find((x) => x.id === e.detail.item.id);
          if (i) this.emit('mandate-picked', { intent: { kind: 'intent', app: 'mandate', id: i.id, title: i.title } satisfies IntentRef });
        }}></ui-list>
      <div><ui-button kind="ghost" size="sm" @click=${() => this.emit('mandate-cancel')}>Cancel</ui-button></div>`;
  }
}

if (!customElements.get('mandate-picker')) customElements.define('mandate-picker', MandatePicker);

declare global {
  interface HTMLElementTagNameMap {
    'mandate-picker': MandatePicker;
  }
}
