import { appCredentialsFromEnv, appStorageFromEnv, commonSettings, loadConfigOrExit, outboxRelay, readManifest, startAppService } from '@augur/service-kit';
import { buildApp } from './app.ts';
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
});

// Tell other apps what happened (mandate.intent.*), from the outbox, once each change has committed.
const { EVENTS_URL } = process.env;
const credentials = appCredentialsFromEnv(manifest.id);
if (databaseUrl && EVENTS_URL && credentials) {
  outboxRelay({ pool: PgMandateStore.outboxPool(databaseUrl), eventsUrl: EVENTS_URL, credentials, onError: (err) => app.log.error({ err: (err as Error).message }, 'could not send events') }).start();
} else if (databaseUrl) {
  app.log.info(`EVENTS_URL or the app’s sign-in is not set, so ${manifest.name}’s events wait in its outbox.`);
}
