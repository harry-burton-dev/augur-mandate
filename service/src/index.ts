import { appCredentialsFromEnv, appStorageFromEnv, commonSettings, followEvents, loadConfigOrExit, outboxRelay, readManifest, startAppService } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { auditFromEnv } from './audit.ts';
import { FOLLOWED, makeFollower } from './follow.ts';
import { inboxFromEnv } from './inbox.ts';
import { notifyFromEnv } from './notices.ts';
import { peopleFromEnv } from './people.ts';
import { organisationZoneFromEnv } from './reminders/organisation.ts';
import { MemoryReminderStore, PgReminderStore } from './reminders/store.ts';
import { scheduleReminders } from './reminders/sweep.ts';
import { MemoryMandateStore, PgMandateStore } from './store.ts';

const manifest = readManifest(import.meta.url);

// Every setting Mandate reads, checked before it starts (in production, a missing one stops it).
loadConfigOrExit(manifest.id, [
  commonSettings.database,
  commonSettings.registry,
  commonSettings.events,
  commonSettings.identity,
  commonSettings.issuer,
  commonSettings.issuerInside,
  commonSettings.clientSecret,
  commonSettings.gateway,
]);

// Mandate keeps its intents in its own schema (docs/app-storage.md). Without one it forgets
// everything on restart, which is fine under pnpm dev:app and never in production.
const { databaseUrl } = appStorageFromEnv();
if (!databaseUrl && process.env.NODE_ENV === 'production') throw new Error(`${manifest.name} needs DATABASE_URL: give it its storage (docs/app-storage.md).`);
const store = databaseUrl ? await PgMandateStore.connect(databaseUrl) : new MemoryMandateStore();

// Builds Mandate, listens, runs its jobs, gives the registry its frontend and puts it in the catalogue.
const app = await startAppService({
  manifest,
  buildApp: () => buildApp({ manifest, store }),
  // Reminders on time (ADR 0061): a sweep every 15 minutes. Without a database jobs don't run on a schedule.
  jobs: (jobs, built) =>
    void scheduleReminders(jobs, {
      app: manifest.id,
      store: databaseUrl ? PgReminderStore.connect(databaseUrl) : new MemoryReminderStore(store as MemoryMandateStore),
      inbox: inboxFromEnv((what) => built.log.info({ inbox: what }, 'inbox item (no inbox here)')),
      zone: organisationZoneFromEnv({ onError: (err) => built.log.warn({ err: err.message }, 'the organisation’s time zone could not be read; reminders use the last one known, else UTC') }),
      log: built.log,
    }),
});

// Tell other apps what happened (mandate.intent.*), from the outbox, once each change has committed.
const { EVENTS_URL } = process.env;
const credentials = appCredentialsFromEnv(manifest.id);
if (databaseUrl && EVENTS_URL && credentials) {
  outboxRelay({ pool: PgMandateStore.outboxPool(databaseUrl), eventsUrl: EVENTS_URL, credentials, onError: (err) => app.log.error({ err: (err as Error).message }, 'could not send events') }).start();
  // Follow what happens around it (MB1): holders who leave, teams renamed, entities retired or merged in Data Atlas.
  const log = (what: object) => app.log.info(what, 'nowhere to send this');
  const handle = makeFollower({ app: manifest, store, people: peopleFromEnv(), audit: auditFromEnv(log), notify: notifyFromEnv(log), inbox: inboxFromEnv(log) });
  followEvents({
    eventsUrl: EVENTS_URL,
    credentials,
    topics: FOLLOWED,
    cursor: { load: () => store.cursor(), save: (seq) => store.saveCursor(seq) },
    handle,
    onError: (err) => app.log.error({ err: (err as Error).message }, 'could not follow events'),
  }).start();
} else if (databaseUrl) {
  app.log.info(`EVENTS_URL or the app’s sign-in is not set, so ${manifest.name}’s events wait in its outbox.`);
}
