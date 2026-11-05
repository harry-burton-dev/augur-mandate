import { appCredentialsFromEnv, serviceHeaders, withDeadline } from '@augur/service-kit';
import { knownZone } from './rules.ts';

/** How long Mandate keeps the organisation's time zone before asking identity again. */
const KEEP_MS = 10 * 60_000;

/**
 * The organisation's time zone (ADR 0042), which reminders are worked out in (ADR 0061). Asked of
 * identity as Mandate and kept for ten minutes; when identity can't say, the last answer, else UTC.
 * With no IDENTITY_URL or sign-in, as under `pnpm dev:app`, always UTC.
 */
export const organisationZoneFromEnv = ({ env = process.env, fetchImpl = fetch, now = Date.now, onError }: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number; onError?: (err: Error) => void } = {}) => {
  const credentials = appCredentialsFromEnv('mandate', env as NodeJS.ProcessEnv);
  const identityUrl = env.IDENTITY_URL;
  if (!identityUrl || !credentials) return async () => 'UTC';
  let kept: { zone: string; at: number } | undefined;
  return async () => {
    if (kept && now() - kept.at < KEEP_MS) return kept.zone;
    try {
      const res = await withDeadline(fetchImpl)(`${identityUrl.replace(/\/$/, '')}/v1/organisation`, { headers: await serviceHeaders(credentials) });
      if (!res.ok) throw new Error(`Identity answered ${res.status}.`);
      kept = { zone: knownZone(((await res.json()) as { timeZone?: string }).timeZone), at: now() };
    } catch (err) {
      onError?.(err as Error);
      return kept?.zone ?? 'UTC';
    }
    return kept.zone;
  };
};
