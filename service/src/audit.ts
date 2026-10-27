import { appCredentialsFromEnv, recordAudit } from '@augur/service-kit';

/** Something Mandate puts in the platform's audit log: who did what to which intent, on which floor. */
export interface MandateAuditEntry {
  actor: string;
  action: string;
  target: string;
  workspace: string;
  detail?: Record<string, unknown>;
}

export type Audit = (entry: MandateAuditEntry) => Promise<void>;

/**
 * Writes to the platform's audit log as Mandate (the `audit:write` scope), or, with no
 * EVENTS_URL or sign-in as under `pnpm dev:app`, only to Mandate's own log.
 */
export const auditFromEnv = (log: (entry: MandateAuditEntry) => void, env = process.env): Audit => {
  const credentials = appCredentialsFromEnv('mandate', env);
  const eventsUrl = env.EVENTS_URL;
  if (!eventsUrl || !credentials) return async (entry) => log(entry);
  return ({ actor, action, target, workspace, detail }) =>
    recordAudit({ eventsUrl, credentials, workspace, entry: { actor: { id: actor, kind: 'user' }, app: 'mandate', action, target, ...(detail ? { detail } : {}) } });
};
