import { defineMicroFrontend, openDocument, openEntity, pickDocument, pickEntities, type EntityRef, type Intent, type MountContext } from '@augur/mfe-sdk';
import { createRoot, type Root } from 'react-dom/client';
import { MandateApi, pathFor, placeFor, type Place } from './api.js';
import { MandateApp } from './app.js';
import { MandateGlance } from './glance.js';
import { MandatePicker } from './picker.js';
import styles from './styles.css?inline';

/** Opens Mandate at a place in it, `{ path }` as its address has it: how its card on Home goes in. */
export const MANDATE_OPEN = 'mandate.open';
/** Opens one intent, `{ id }`. */
export const AIM_OPEN = 'aim.open';
/** Asks the person to pick an intent: answers with an IntentRef. A briefing tool bounds its context this way. */
export const AIM_PICK = 'aim.pick';

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

const apiFor = (ctx: MountContext) => new MandateApi((path, init) => ctx.fetch(path, init));

const roots = new WeakMap<HTMLElement, Root>();
const STYLE_ID = 'augur-mandate-styles';

/** A React root in `el`, with Mandate's stylesheet on the page once. */
const rootIn = (el: HTMLElement) => {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = styles;
    document.head.append(style);
  }
  const root = createRoot(el);
  roots.set(el, root);
  return root;
};
const unmount = (el: HTMLElement) => {
  roots.get(el)?.unmount();
  roots.delete(el);
};

/** Mandate: intent, passed down floor by floor. What the shell mounts at /mandate. */
export default defineMicroFrontend({
  mount(el: HTMLElement, ctx: MountContext) {
    const root = rootIn(el);
    // Another app asked for an intent: Mandate opens over it as a picker, and answers with the one chosen.
    if (ctx.intent?.type === AIM_PICK && ctx.reply) {
      const reply = ctx.reply;
      const purpose = (ctx.intent.payload as { purpose?: unknown } | undefined)?.purpose;
      root.render(<MandatePicker api={apiFor(ctx)} purpose={typeof purpose === 'string' ? purpose : ''} onPick={(intent) => reply.respond(intent)} onCancel={() => reply.cancel()} />);
      return;
    }
    let mountedAt = ctx.path;
    const moved = (place: Place) => {
      const to = addressFor(window.location.pathname, mountedAt, place);
      if (!to || to === window.location.pathname) return;
      window.history.pushState(window.history.state, '', to);
      mountedAt = pathFor(place);
    };
    root.render(
      <MandateApp
        api={apiFor(ctx)}
        floorName={ctx.workspace.name}
        floorKind={ctx.workspace.kind}
        place={placeForIntent(ctx.intent) ?? placeFor(ctx.path)}
        onPlace={moved}
        pickDocument={() => pickDocument(ctx, { purpose: 'Add to this intent as context' })}
        pickEntity={async () => (await pickEntities(ctx, { purpose: 'Bind to this intent' }))[0]!}
        openDocument={(ref) => void openDocument(ctx, ref)}
        openEntity={(ref: EntityRef) => void openEntity(ctx, ref)}
      />,
    );
  },
  unmount,
  surfaces: {
    /** The card on Home: what's waiting on the person, and how the floor's intents stand. */
    './Glance': {
      mount(el: HTMLElement, ctx: MountContext) {
        rootIn(el).render(
          <MandateGlance
            api={apiFor(ctx)}
            onOpen={(id) => void ctx.raise({ type: AIM_OPEN, payload: { id } })}
            onOpenYours={() =>
              void ctx.raise({
                type: MANDATE_OPEN,
                payload: { path: '/yours' },
              })
            }
          />,
        );
      },
      unmount,
    },
  },
});
