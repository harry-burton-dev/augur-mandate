import { IntentError, defineMicroFrontend, openDocument, pickDocument, type Intent, type MountContext } from '@augur/mfe-sdk';
import { html, render } from 'lit';
import '@augur/ui-kit';
import { MandateApi, pathFor, placeFor, type EntityRef, type IntentRef, type Place } from './api.js';
import './mandate-app.js';
import './mandate-glance.js';
import './mandate-picker.js';

/** Opens Mandate at a place in it, `{ path }` as its address has it: how its card on Home goes in. */
export const MANDATE_OPEN = 'mandate.open';
/** Opens one intent, `{ id }`. */
export const AIM_OPEN = 'aim.open';
/** Asks the person to pick an intent: answers with an IntentRef. A briefing tool bounds its context this way. */
export const AIM_PICK = 'aim.pick';
/** Data Atlas's intents, as the shared entity contract names them. */
export const ENTITY_PICK = 'entity.pick';
export const ENTITY_OPEN = 'entity.open';

/** Where Mandate is in the address bar, so a place can be shared and Back goes to the last one. */
export const addressFor = (pathname: string, mountedAt: string, place: Place) => {
  const inner = mountedAt === '/' ? '' : mountedAt;
  if (!pathname.endsWith(inner)) return undefined;
  return `${pathname.slice(0, pathname.length - inner.length)}${pathFor(place)}`;
};

/** Where an intent asks Mandate to start. */
export const placeForIntent = (intent: Intent | undefined): Place | undefined => {
  const payload = (intent?.payload ?? {}) as { path?: unknown; id?: unknown };
  if (intent?.type === MANDATE_OPEN && typeof payload.path === 'string') return placeFor(payload.path);
  if (intent?.type === AIM_OPEN && typeof payload.id === 'string' && payload.id) return { view: 'intent', id: payload.id };
  return undefined;
};

const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** An entity as Data Atlas answers `entity.pick`: one ref, or the first of a list. */
export const entityFrom = (answer: unknown): EntityRef => {
  const r = (Array.isArray(answer) ? answer[0] : answer) as Record<string, unknown> | undefined;
  if (!r || r.kind !== 'entity' || !text(r.id, 200) || !text(r.type, 80) || !text(r.label, 300)) throw new IntentError('The picker answered with something that is not an entity.');
  return { kind: 'entity', id: r.id as string, type: r.type as string, label: r.label as string };
};

const apiFor = (ctx: MountContext) => new MandateApi((path, init) => ctx.fetch(path, init));

/** Mandate: intent, passed down floor by floor. What the shell mounts at /mandate. */
export default defineMicroFrontend({
  mount(el: HTMLElement, ctx: MountContext) {
    // Another app asked for an intent: Mandate opens over it as a picker, and answers with the one chosen.
    if (ctx.intent?.type === AIM_PICK && ctx.reply) {
      const reply = ctx.reply;
      const purpose = (ctx.intent.payload as { purpose?: unknown } | undefined)?.purpose;
      render(
        html`<mandate-picker
          .api=${apiFor(ctx)}
          purpose=${typeof purpose === 'string' ? purpose : ''}
          @mandate-picked=${(e: CustomEvent<{ intent: IntentRef }>) => reply.respond(e.detail.intent)}
          @mandate-cancel=${() => reply.cancel()}
        ></mandate-picker>`,
        el,
      );
      return;
    }
    let mountedAt = ctx.path;
    const moved = (e: CustomEvent<Place>) => {
      const to = addressFor(window.location.pathname, mountedAt, e.detail);
      if (!to || to === window.location.pathname) return;
      window.history.pushState(window.history.state, '', to);
      mountedAt = pathFor(e.detail);
    };
    render(
      html`<mandate-app
        .api=${apiFor(ctx)}
        floor-name=${ctx.workspace.name}
        floor-kind=${ctx.workspace.kind}
        .place=${placeForIntent(ctx.intent) ?? placeFor(ctx.path)}
        .pickDocument=${() => pickDocument(ctx, { purpose: 'Add to this intent as context' })}
        .pickEntity=${async () => entityFrom(await ctx.request<unknown>({ type: ENTITY_PICK, payload: { multiple: false, purpose: 'Bind to this intent' } }))}
        .openDocument=${(ref: Parameters<typeof openDocument>[1]) => void openDocument(ctx, ref)}
        .openEntity=${(ref: EntityRef) => void ctx.raise({ type: ENTITY_OPEN, payload: ref })}
        @mandate-place=${moved}
      ></mandate-app>`,
      el,
    );
  },
  unmount(el: HTMLElement) {
    render(html``, el);
  },
  surfaces: {
    /** The card on Home: what's waiting on the person, and how the floor's intents stand. */
    './Glance': {
      mount(el: HTMLElement, ctx: MountContext) {
        render(
          html`<mandate-glance
            .api=${apiFor(ctx)}
            @mandate-open=${(e: CustomEvent<{ id: string }>) => void ctx.raise({ type: AIM_OPEN, payload: { id: e.detail.id } })}
            @mandate-open-yours=${() => void ctx.raise({ type: MANDATE_OPEN, payload: { path: '/yours' } })}
          ></mandate-glance>`,
          el,
        );
      },
      unmount(el: HTMLElement) {
        render(html``, el);
      },
    },
  },
});
