import { appCredentialsFromEnv, notify, type NotificationAction } from '@augur/service-kit';

/** Something Mandate tells people through the shell's stream, on the floor it happened on. */
export interface MandateNotice {
  recipients: string[];
  workspace: string;
  title: string;
  detail?: string;
  /** Whether it asks them to do something: a back-brief, an answer to a concern. */
  needsYou?: boolean;
  /** Path inside Mandate to open: `/intents/<id>`. */
  link?: string;
  actions?: NotificationAction[];
}

export type Notify = (notice: MandateNotice) => Promise<void>;

/** The most people one notification goes to; a larger team is told in turns. */
const PER_CALL = 500;

/**
 * Tells people as Mandate (the `notifications:send` scope), or, with no
 * EVENTS_URL or sign-in as under `pnpm dev:app`, only writes it in Mandate's log.
 */
export const notifyFromEnv = (log: (notice: MandateNotice) => void, env = process.env): Notify => {
  const credentials = appCredentialsFromEnv('mandate', env);
  const eventsUrl = env.EVENTS_URL;
  if (!eventsUrl || !credentials) return async (notice) => log(notice);
  return async ({ recipients, workspace, needsYou, ...notice }) => {
    for (let i = 0; i < recipients.length; i += PER_CALL)
      await notify({ eventsUrl, credentials, workspace, notification: { app: 'mandate', level: needsYou ? 'needs' : 'info', recipients: recipients.slice(i, i + PER_CALL), ...notice } });
  };
};
