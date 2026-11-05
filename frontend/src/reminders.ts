import { dayName, parseDay } from '@augur/app-kit';

/** Where the back-brief-by date starts when passing a part down: three days ahead. */
export const BRIEF_BY_DEFAULT = '+3d';

/** The back-brief-by date picked for a new part, as the pass dialog starts it. */
export const briefByDefault = (now = new Date()) => parseDay(BRIEF_BY_DEFAULT, now) ?? '';

/** Quick choices beside the back-brief-by date. */
export const BRIEF_BY_QUICK = [
  { label: 'Tomorrow', value: 'tomorrow' },
  { label: 'In 3 days', value: '+3d' },
  { label: 'In a week', value: '+1w' },
];

/** A part still waiting for its back-brief, in words: "Back-brief by Thu 5 Nov", or "Back-brief was due on Thu 5 Nov" once late. */
export const briefWords = (i: { life: string; briefBy?: string }, now = new Date()) => {
  if (i.life !== 'passed' || !i.briefBy) return '';
  const today = parseDay('today', now) ?? '';
  return i.briefBy < today ? `Back-brief was due on ${dayName(i.briefBy, now)}` : `Back-brief by ${dayName(i.briefBy, now)}`;
};
