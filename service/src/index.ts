import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCredentialsFromEnv, appStorageFromEnv, outboxRelay, publishFrontend, registerApp } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { MemoryMandateStore, PgMandateStore } from './store.ts';

const port = Number(process.env.PORT ?? 8090);
// Mandate keeps its intents in its own schema (docs/app-storage.md). Without one it forgets
// everything on restart, which is fine under pnpm dev:app and never in production.
const { databaseUrl } = appStorageFromEnv();
if (!databaseUrl && process.env.NODE_ENV === 'production') throw new Error('Mandate needs DATABASE_URL: give it its storage (docs/app-storage.md).');
const store = databaseUrl ? await PgMandateStore.connect(databaseUrl) : new MemoryMandateStore();
const app = await buildApp({ store });
await app.listen({ port, host: '0.0.0.0' });

// Put Mandate in the platform's catalogue, so the shell can offer it.
// It signs in as itself with SERVICE_CLIENT_SECRET (issued for it by an admin in Admin, Apps, or
// by the app runner when it installs the app). The build puts the manifest beside the code; from source
// it's in apps/mandate. A released image carries the built frontend too (APP_FRONTEND, or /app/frontend),
// which it gives the registry first, so the shell loads this version's own copy of it.
const { REGISTRY_URL, APP_MANIFEST, APP_FRONTEND } = process.env;
const credentials = appCredentialsFromEnv('mandate');
if (REGISTRY_URL && credentials) {
  const built = new URL('./manifest.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(APP_MANIFEST ?? (existsSync(built) ? built : new URL('../../manifest.json', import.meta.url)), 'utf8'));
  const frontend = APP_FRONTEND ?? fileURLToPath(new URL('../frontend/', import.meta.url));
  const giveFrontend = existsSync(join(frontend, 'entry.js'))
    ? publishFrontend({ registryUrl: REGISTRY_URL, credentials, app: manifest.id, version: manifest.version, dir: frontend })
        .then((kept) => app.log.info({ version: manifest.version, kept }, kept ? 'frontend kept by version' : 'this deployment doesn’t keep frontends by version'))
        .catch((err: Error) => app.log.error(err.message))
    : Promise.resolve();
  void giveFrontend
    .then(() => registerApp({ registryUrl: REGISTRY_URL, credentials, manifest }))
    .then(() => app.log.info({ app: manifest.id, version: manifest.version }, 'registered with the platform'))
    .catch((err: Error) => app.log.error(err.message));
} else {
  app.log.info('REGISTRY_URL or the app’s sign-in (SERVICE_CLIENT_SECRET) is not set, so Mandate is not in the catalogue (fine under pnpm dev:app).');
}

// Tell other apps what happened (mandate.intent.*), from the outbox, once each change has committed.
const { EVENTS_URL } = process.env;
if (databaseUrl && EVENTS_URL && credentials) {
  outboxRelay({ pool: PgMandateStore.outboxPool(databaseUrl), eventsUrl: EVENTS_URL, credentials, onError: (err) => app.log.error({ err: (err as Error).message }, 'could not send events') }).start();
} else if (databaseUrl) {
  app.log.info('EVENTS_URL or the app’s sign-in is not set, so Mandate’s events wait in its outbox.');
}
