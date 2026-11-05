import type { InboxOwner, Jobs, NewInboxItem } from '@augur/service-kit';
import { backBriefKey, checkInKey, INBOX_KINDS, lateBackBriefKey, type MandateInbox } from '../inbox.ts';
import type { Intent } from '../store.ts';
import { addDays, dayIn, daysBetween, nextAfter, ruleOf } from './rules.ts';
import type { Reminder, ReminderStore } from './store.ts';

/**
 * Reminders on time (ADR 0061, Mandate's MB3). Every 15 minutes a sweep finds what has come due and
 * puts it in the Inbox (AUGUR's ADR 0026), once:
 *
 * - a part's back-brief due tomorrow: its holder's back-brief item says so;
 * - a back-brief late: its holder's item says so, and the giver gets an item of their own;
 * - an assessment due by the intent's rhythm: its holder gets "How is it going?".
 *
 * Each claims its row first (`reminded_brief_for`, `reminded_rating_for`), so it is sent once per due
 * date however many instances sweep. Items whose work is done are taken back on the next sweep.
 */

export const REMINDER_JOB = 'reminders';
/** Every 15 minutes. */
export const REMINDER_CRON = '*/15 * * * *';

/** The words the Inbox shows, in one place. */
export const reminderWords = {
  briefSoon: (i: Intent, tomorrow: boolean) => `Back-brief ${i.title} by ${tomorrow ? 'tomorrow' : 'today'}. Say it back in your own words to accept it.`,
  briefLate: (i: Intent) => `${i.title} is waiting for its back-brief. Say it back in your own words to accept it.`,
  giverLate: (i: Intent) => `${i.title} is waiting for its back-brief from ${i.holderName}.`,
  checkIn: (i: Intent, days: number | undefined) =>
    days === undefined ? `How is ${i.title} going? Nothing said yet.` : `How is ${i.title} going? Last said ${days === 1 ? 'a day' : `${days} days`} ago.`,
};

export interface SweepOptions {
  store: ReminderStore;
  inbox: MandateInbox;
  /** The organisation's time zone. */
  zone: () => Promise<string>;
  /** Mandate's id, for the items' subject. */
  app: string;
  now?: () => Date;
  log?: { error(obj: unknown, msg?: string): void };
}

/** What one sweep did, for the job's log. */
export interface SweepResult {
  sent: number;
  closed: number;
  failed: number;
}

const personOf = (holder: string) => (holder.startsWith('person:') ? holder.slice('person:'.length) : undefined);

/** Whoever holds it: the person, or the team's leads for the team. */
const ownerOf = (i: Intent): InboxOwner => {
  const person = personOf(i.holder);
  return person ? { kind: 'person', id: person } : { kind: 'team', id: i.workspace, role: 'lead' };
};

export const sweepReminders = async ({ store, inbox, zone: zoneOf, app, now = () => new Date(), log }: SweepOptions): Promise<SweepResult> => {
  const at = now();
  const zone = await zoneOf();
  const today = dayIn(zone, at);
  const tomorrow = addDays(today, 1);
  const result: SweepResult = { sent: 0, closed: 0, failed: 0 };
  const subject = (i: Intent) => ({ kind: 'ref' as const, app, type: 'intent', id: i.id, label: i.title });

  /** Claims a reminder, sends it, and gives the claim back if it couldn't be sent. */
  const once = async (what: Reminder, i: Intent, value: string, previous: string | undefined, send: () => Promise<void>) => {
    if (!(await store.claim(what, i.id, value))) return;
    try {
      await send();
      result.sent++;
    } catch (err) {
      result.failed++;
      log?.error({ err: (err as Error).message, intent: i.id, reminder: value }, 'could not send a reminder; the next sweep tries again');
      await store.release(what, i.id, value, previous);
    }
  };

  // Back-briefs due by tomorrow, or late.
  const waiting = await store.waitingForBriefs(tomorrow);
  const briefWas = await store.reminded('brief', waiting.map((i) => i.id));
  for (const i of waiting) {
    const due = i.briefBy!;
    if (due >= today) {
      await once('brief', i, `soon:${due}`, briefWas.get(i.id), () => inbox.change(backBriefKey(i.id), { detail: reminderWords.briefSoon(i, due === tomorrow), due }));
      continue;
    }
    await once('brief', i, `late:${due}`, briefWas.get(i.id), async () => {
      await inbox.change(backBriefKey(i.id), { detail: reminderWords.briefLate(i), due });
      const giver = i.passedBy;
      if (!giver || giver === personOf(i.holder)) return;
      const item: NewInboxItem = {
        kind: INBOX_KINDS.lateBackBrief,
        owner: { kind: 'person', id: giver },
        title: i.title,
        detail: reminderWords.giverLate(i),
        subject: subject(i),
        path: `/intents/${i.id}`,
        due,
        // Chasing it is a word with whoever holds it, in Mandate; it closes itself once they back-brief.
        allow: { decline: false, handOn: false, selfComplete: true },
        reopen: true,
      };
      await inbox.put(lateBackBriefKey(i.id), i.workspace, item);
    });
  }

  // The giver's late items, once the back-brief is in or the part has ended.
  for (const { intent: i, value } of await store.remindedWith('brief', 'late:')) {
    if (i.life === 'passed') continue;
    if (!(await store.claim('brief', i.id, `closed:${value}`))) continue;
    await inbox.close(lateBackBriefKey(i.id), i.life === 'active' ? 'done' : 'withdrawn').catch((err: Error) => log?.error({ err: err.message, intent: i.id }, 'could not take back a reminder'));
    result.closed++;
  }

  // Assessments due by each intent's rhythm. Rules repeat at most daily, so nothing assessed in the last day is due.
  const underWay = await store.underWay(new Date(at.getTime() - 86_400_000));
  const ratingWas = await store.reminded('rating', underWay.map((i) => i.id));
  for (const i of underWay) {
    const since = new Date(i.ratedAt ?? i.passedAt ?? i.createdAt);
    let due: Date | undefined;
    try {
      due = nextAfter(ruleOf(i), since, zone);
    } catch (err) {
      log?.error({ err: (err as Error).message, intent: i.id }, 'an intent’s rhythm could not be read');
      continue;
    }
    if (!due || due > at) continue;
    await once('rating', i, `due:${due.toISOString()}`, ratingWas.get(i.id), () =>
      inbox.put(checkInKey(i.id), i.workspace, {
        kind: INBOX_KINDS.checkIn,
        owner: ownerOf(i),
        title: i.title,
        detail: reminderWords.checkIn(i, i.ratedAt ? daysBetween(since, at) : undefined),
        subject: subject(i),
        path: `/intents/${i.id}`,
        due: due!.toISOString(),
        // Saying how it's going is Mandate's own step; the item closes itself once they do.
        allow: { decline: false, handOn: false, selfComplete: false },
        reopen: true,
      }),
    );
  }

  // "How is it going?" once it has been said, or the intent is no longer under way.
  for (const { intent: i, value } of await store.remindedWith('rating', 'due:')) {
    const due = value.slice('due:'.length);
    const said = i.ratedAt && Date.parse(i.ratedAt) >= Date.parse(due);
    if (i.life === 'active' && !said) continue;
    if (!(await store.claim('rating', i.id, `closed:${due}`))) continue;
    await inbox.close(checkInKey(i.id), i.life === 'active' || i.life === 'achieved' ? 'done' : 'withdrawn').catch((err: Error) => log?.error({ err: err.message, intent: i.id }, 'could not take back a reminder'));
    result.closed++;
  }

  return result;
};

/** The scheduled job: one sweep every 15 minutes, once across every instance (the service kit's jobs, on DBOS). */
export const scheduleReminders = (jobs: Jobs, options: SweepOptions) =>
  jobs.schedule(REMINDER_JOB, REMINDER_CRON, async (ctx) => {
    // One step: a sweep resumed after a restart runs again, and its claims keep it from sending twice.
    const done = await ctx.step('sweep', () => sweepReminders({ ...options, now: () => ctx.scheduledAt ?? options.now?.() ?? new Date() }));
    if (done.sent || done.closed || done.failed) ctx.log.info(done, 'reminders swept');
  });
