import { appCredentialsFromEnv, appStorageFromEnv, commonSettings, followEvents, loadConfigOrExit, outboxRelay, readManifest, startAppService } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { auditFromEnv } from './audit.ts';
import { FOLLOWED, makeFollower } from './follow.ts';
import { inboxFromEnv } from './inbox.ts';
import { notifyFromEnv } from './notices.ts';
import { peopleFromEnv } from './people.ts';
import { organisationZoneFromEnv } from './reminders/organisation.ts';
import { PgReminderStore } from './reminders/store.ts';
import { scheduleReminders } from './reminders/sweep.ts';
import { PgMandateStore } from './store.ts';

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

// Mandate keeps its intents in its own schema (docs/app-storage.md), under pnpm dev:app too: the dev stack's Postgres.
const { databaseUrl } = appStorageFromEnv();
if (!databaseUrl) throw new Error(`${manifest.name} needs DATABASE_URL: its own schema in Postgres (docs/app-storage.md). Under pnpm dev:app, the dev stack’s: docker compose -f infra/docker-compose.yml up -d postgres in AUGUR.`);
const store = await PgMandateStore.connect(databaseUrl);

// Builds Mandate, listens, runs its jobs, gives the registry its frontend and puts it in the catalogue.
const app = await startAppService({
  manifest,
  buildApp: () => buildApp({ manifest, store }),
  // Reminders on time (ADR 0061): a sweep every 15 minutes.
  jobs: (jobs, built) =>
    void scheduleReminders(jobs, {
      app: manifest.id,
      store: PgReminderStore.connect(databaseUrl),
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
