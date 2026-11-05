import * as rrulePackage from 'rrule';
import type { Intent } from '../store.ts';

// rrule is CommonJS to Node and an ES module to Vite: take it from whichever shape arrives.
const { RRule, Frequency } = (rrulePackage as unknown as { default?: typeof rrulePackage }).default ?? rrulePackage;

/**
 * Recurring times (ADR 0061): an RFC 5545 RRULE without DTSTART, read with `rrule`, worked out in the
 * organisation's time zone. The thing's own start (when it was last assessed) is the rule's start.
 */

/** The longest rule Mandate keeps. */
export const RULE_MAX = 200;

/** Rules repeat at most daily, so one sweep never owes more than one reminder per thing. */
const SLOWEST_FIRST = [Frequency.YEARLY, Frequency.MONTHLY, Frequency.WEEKLY, Frequency.DAILY];

/** An intent's rhythm as a rule: its own, or every `rhythmDays` days, which is what it meant before rules. */
export const ruleOf = (i: Pick<Intent, 'rhythm' | 'rhythmDays'>) => i.rhythm ?? `FREQ=DAILY;INTERVAL=${i.rhythmDays}`;

/** Why a rule someone chose can't be kept, in words; undefined when it can. */
export const ruleProblem = (text: string): string | undefined => {
  const rule = text.trim().replace(/^RRULE:/i, '');
  if (!rule) return 'Say how often, such as FREQ=WEEKLY;BYDAY=MO.';
  if (rule.length > RULE_MAX) return `A rhythm is at most ${RULE_MAX} characters.`;
  if (/DTSTART|\n/i.test(rule)) return 'A rhythm starts from when it was last assessed: leave DTSTART out.';
  let freq: number;
  try {
    freq = RRule.parseString(rule).freq ?? -1;
  } catch {
    return 'That isn’t a rhythm AUGUR can read. Write it as an RFC 5545 rule, such as FREQ=WEEKLY;BYDAY=MO.';
  }
  if (!SLOWEST_FIRST.includes(freq)) return 'A rhythm repeats at most once a day: use DAILY, WEEKLY, MONTHLY or YEARLY.';
  return undefined;
};

/** The rule as it is kept: without a leading RRULE:, upper case. */
export const tidyRule = (text: string) => text.trim().replace(/^RRULE:/i, '').toUpperCase();

/** A time zone AUGUR can use, else UTC. */
export const knownZone = (zone: string | undefined) => {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
};

/** The wall clock in `zone` at `at`, written as if it were UTC: how rrule wants local times. */
const wallClock = (at: Date, zone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!));
};

/** The instant whose wall clock in `zone` reads `wall`. Twice round, so a change of clocks in between is caught. */
const fromWallClock = (wall: Date, zone: string) => {
  let at = new Date(wall.getTime());
  for (let n = 0; n < 2; n++) at = new Date(wall.getTime() - (wallClock(at, zone).getTime() - at.getTime()));
  return at;
};

/** The first time the rule comes round after `from`, in `zone`; undefined when it never does again. */
export const nextAfter = (rule: string, from: Date, zone: string): Date | undefined => {
  const start = wallClock(from, zone);
  const next = new RRule({ ...RRule.parseString(rule), dtstart: start }).after(start, false);
  return next ? fromWallClock(next, zone) : undefined;
};

/** The day it is in `zone` at `at`, as YYYY-MM-DD. */
export const dayIn = (zone: string, at: Date) => wallClock(at, zone).toISOString().slice(0, 10);

/** The day `n` days after `day` (YYYY-MM-DD). */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Whole days from one instant to another, rounded down. */
export const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/** Monday to Friday. AUGUR has no setting for an organisation's working week yet. */
const working = (day: string) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());

/** The day `n` working days after `day` (YYYY-MM-DD): raised on a Friday, two working days on is Tuesday. */
export const addWorkingDays = (day: string, n: number) => {
  let at = day;
  for (let left = n; left > 0; ) {
    at = addDays(at, 1);
    if (working(at)) left--;
  }
  return at;
};
