import { appCredentialsFromEnv, inboxItem, updateInboxItem, type NewInboxItem } from '@augur/service-kit';

/**
 * Work that waits on someone, in the shell's Inbox (AUGUR's ADR 0026): a part passed down waits for its
 * back-brief there until it's said back, and is taken back if the intent above closes first. Kept by key,
 * so putting one again (on start, or after a failure) changes the one item.
 */
export interface MandateInbox {
  /** Puts an item in someone's inbox, or changes the one with this key. `reopen` opens a closed one again. */
  put(key: string, workspace: string, item: NewInboxItem): Promise<void>;
  /** The work is done in Mandate, or there's no longer any to do. */
  close(key: string, state: 'done' | 'withdrawn'): Promise<void>;
}

/** The kinds Mandate declares in its manifest's `inbox.kinds`. */
export const INBOX_KINDS = { backBrief: 'back-brief', needsHolder: 'needs-holder' } as const;

/** The key of a part's back-brief item. */
export const backBriefKey = (intent: string) => `back-brief/${intent}`;

/** The key of the item that asks whoever passed a part down to pass it again, once its holder can't hold it. */
export const needsHolderKey = (intent: string) => `needs-holder/${intent}`;

/**
 * Puts work in people's inboxes as Mandate (the `inbox:write` scope), or, with no EVENTS_URL or
 * sign-in as under `pnpm dev:app`, only writes it in Mandate's log.
 */
export const inboxFromEnv = (log: (what: { key: string; item?: NewInboxItem; state?: string }) => void, env = process.env): MandateInbox => {
  const credentials = appCredentialsFromEnv('mandate', env);
  const eventsUrl = env.EVENTS_URL;
  if (!eventsUrl || !credentials)
    return {
      put: async (key, _workspace, item) => log({ key, item }),
      close: async (key, state) => log({ key, state }),
    };
  return {
    put: async (key, workspace, item) => void (await inboxItem({ eventsUrl, credentials, workspace, app: 'mandate', key, item })),
    close: async (key, state) => void (await updateInboxItem({ eventsUrl, credentials, app: 'mandate', key, change: { state } })),
  };
};
