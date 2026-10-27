import { LitElement, html, nothing } from 'lit';
import type { Fact, ListItem } from '@augur/ui-kit';
import type { HomeGlance, MandateApi } from './api.js';

/** How many intents the card names: it's a glance, not a list. */
const NAMED = 2;

/**
 * Mandate's card on Home: what's waiting on the person (parts passed to them to
 * say back, or ones whose parent changed), and how this floor's intent stands.
 *
 * @fires mandate-open - detail `{ id }`, to open one intent
 * @fires mandate-open-yours - to see everything they hold
 */
export class MandateGlance extends LitElement {
  static override properties = {
    api: { attribute: false },
    glance: { state: true },
    failure: { state: true },
  };

  declare api: MandateApi;
  declare glance: HomeGlance | undefined;
  declare failure: string;

  constructor() {
    super();
    this.failure = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.load();
  }

  async load() {
    this.failure = '';
    try {
      this.glance = await this.api.home();
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  private emit(name: string, detail: object = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t reach Mandate" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const glance = this.glance;
    if (!glance) return html`<ui-facts loading count="3"></ui-facts>`;
    const facts: Fact[] = [
      { value: glance.waiting.length, label: 'Waiting on you' },
      { value: glance.floor.active, label: 'Under way here' },
      ...(glance.floor.atRisk || glance.floor.blocked ? [{ value: glance.floor.atRisk + glance.floor.blocked, label: 'At risk or blocked' }] : []),
    ];
    const rows: ListItem[] = glance.waiting.slice(0, NAMED).map((i) => ({ id: i.id, title: i.title, detail: i.partOf ? `Part of ${i.partOf}` : i.floorName, status: 'needs', icon: 'compass' }));
    return html`<style>
        mandate-glance { display: flex; flex-direction: column; gap: var(--space-3); }
      </style>
      <ui-facts .items=${facts}></ui-facts>
      ${rows.length
        ? html`<ui-list label="Waiting on you" density="compact" .bar=${false} .items=${rows}
            @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.emit('mandate-open', { id: e.detail.item.id })}></ui-list>`
        : nothing}
      <div><ui-button kind="secondary" size="sm" @click=${() => this.emit('mandate-open-yours')}>What you hold${glance.holding ? ` (${glance.holding})` : ''}</ui-button></div>`;
  }
}

if (!customElements.get('mandate-glance')) customElements.define('mandate-glance', MandateGlance);

declare global {
  interface HTMLElementTagNameMap {
    'mandate-glance': MandateGlance;
  }
}
