import { defineReactApp } from '@augur/app-kit';
import type { MountContext } from '@augur/mfe-sdk';
import manifest from '../../manifest.json';
import { MandateApp, places } from './app.js';
import { MandateGlance } from './glance.js';
import { AIM_OPEN, MANDATE_OPEN } from './intents.js';
import { MandatePicker } from './picker.js';
import styles from './styles.css?inline';

export { AIM_OPEN, AIM_PICK, MANDATE_OPEN } from './intents.js';

/** Where an intent asks Mandate to start: a place's path, or nothing to start where the address says. */
export const startFor: Record<string, (payload: unknown) => string | undefined> = {
  [MANDATE_OPEN]: (payload) => {
    const path = (payload as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' && path.startsWith('/') ? path : undefined;
  },
  [AIM_OPEN]: (payload) => {
    const id = (payload as { id?: unknown } | undefined)?.id;
    return typeof id === 'string' && id ? places.intent.to({ id }) : undefined;
  },
};

/**
 * Mandate: intent, passed down floor by floor. What the shell mounts at its route; another app's
 * `aim.pick` mounts the picker, and its card on Home is the Glance.
 */
export default defineReactApp<MountContext>({
  name: manifest.name,
  App: MandateApp,
  routes: places,
  intents: startFor,
  Picker: MandatePicker,
  Glance: MandateGlance,
  styles,
});
