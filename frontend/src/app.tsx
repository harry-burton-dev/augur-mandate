import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { DocumentRef } from '@augur/mfe-sdk';
import {
  AppFrame,
  Button,
  Card,
  Cards,
  Checkbox,
  CheckboxGroup,
  DateField,
  Dialog,
  Editor,
  List,
  Note,
  Notice,
  PageHead,
  Path,
  Prose,
  RailLink,
  Refs,
  Section,
  Select,
  State,
  Status,
  Tally,
  TextField,
  Timeline,
  dayName,
  floorMark,
  plainText,
  relativeTime,
  type ButtonKind,
  type DialogSubmit,
  type ListItem,
  type PageAction,
  type PathStep,
  type SelectOption,
  type StatusName,
  type TimelineItem,
} from '@augur/app-kit';
import {
  RATING_WORDS,
  ROLE_WORDS,
  type Branch,
  type Detail,
  type EntityRef,
  type Floor,
  type FloorItem,
  type FloorKind,
  type MandateApi,
  type Place,
  type Rating,
  type Statement,
  type Summary,
  type Target,
  type Yours,
} from './api.js';

/** How a summary's state reads, as a mark and a word: where it is in its life, else how its holder judges it. */
export const markOf = (i: Pick<Summary, 'life' | 'rating'>): { status: StatusName; label: string } => {
  switch (i.life) {
    case 'draft':
      return { status: 'paused', label: 'Draft' };
    case 'passed':
      return { status: 'needs', label: 'Waiting for a back-brief' };
    case 'achieved':
      return { status: 'done', label: 'Achieved' };
    case 'superseded':
      return { status: 'done', label: 'Closed' };
    case 'withdrawn':
      return { status: 'paused', label: 'Withdrawn' };
  }
  switch (i.rating) {
    case 'at_risk':
      return { status: 'warning', label: 'At risk' };
    case 'blocked':
      return { status: 'failed', label: 'Blocked' };
    case 'achieved':
      return { status: 'done', label: 'Says achieved' };
    case 'on_track':
      return { status: 'running', label: 'On track' };
    default:
      return { status: 'queued', label: 'Under way' };
  }
};

/** Who holds it, in words. */
export const holderWords = (i: Pick<Summary, 'holder' | 'holderName' | 'floorName'>) => (i.holder === 'floor' ? `${i.holderName || i.floorName || 'This floor'}’s leads` : i.holderName || 'Someone');

/** The statement's parts, in the order allied orders give them, with what each asks for. */
export const PARTS: {
  key: Exclude<keyof Statement, 'keyTasks'> | 'keyTasks';
  label: string;
  hint: string;
  required?: boolean;
  guide?: string;
}[] = [
  {
    key: 'mission',
    label: 'Mission',
    hint: 'One line: who does what, when and where.',
    guide: '1 sentence',
  },
  {
    key: 'purpose',
    label: 'Purpose',
    hint: 'Why: what it’s in order to achieve.',
    required: true,
    guide: '2 sentences',
  },
  {
    key: 'endState',
    label: 'End state',
    hint: 'What done looks like, so anyone can tell.',
    required: true,
    guide: '2 sentences',
  },
  {
    key: 'keyTasks',
    label: 'Key tasks',
    hint: 'What must be done for it to succeed. One a line.',
  },
  {
    key: 'constraints',
    label: 'Constraints',
    hint: 'What must be done, or kept to.',
  },
  { key: 'restraints', label: 'Restraints', hint: 'What must not be done.' },
  {
    key: 'freedoms',
    label: 'Freedoms',
    hint: 'What whoever holds it may decide for themselves.',
  },
];

const RATING_OPTIONS: SelectOption[] = (Object.keys(RATING_WORDS) as Rating[]).map((value) => ({ value, label: RATING_WORDS[value] }));
const ROLE_OPTIONS: SelectOption[] = Object.entries(ROLE_WORDS).map(([value, label]) => ({
  value,
  label,
  detail: {
    subject: 'What it’s about or acts on',
    resource: 'Put to the work',
    area: 'A place it’s bounded by',
    related: 'Worth knowing about',
  }[value],
}));

type DialogName = 'new' | 'edit' | 'pass' | 'accept' | 'concern' | 'assess' | 'achieve' | 'withdraw' | 'role';

export interface MandateAppProps {
  api: MandateApi;
  floorName: string;
  floorKind: FloorKind;
  place: Place;
  /** Where the person went, for the address bar. */
  onPlace?: (place: Place) => void;
  pickDocument?: () => Promise<DocumentRef>;
  pickEntity?: () => Promise<EntityRef>;
  openDocument?: (ref: DocumentRef) => void;
  openEntity?: (ref: EntityRef) => void;
}

/** The draft differs from what was last issued, or nothing has been yet. */
const unissued = (d: Detail) => {
  if (!d.draft) return false;
  if (!d.issued) return true;
  return JSON.stringify(d.draft) !== JSON.stringify(d.statement) || d.versions[0]?.title !== d.intent.title;
};

const history = (d: Detail): TimelineItem[] => [
  ...d.versions.map((v) => ({
    at: v.at,
    who: v.by,
    what: v.version === 1 ? 'issued it' : `issued version ${v.version}`,
  })),
  ...d.backBriefs.map((b) => ({
    at: b.at,
    who: b.byName,
    what: b.outcome === 'accepted' ? `back-briefed: “${plainText(b.words)}”` : `raised a concern: “${plainText(b.concern)}”`,
  })),
  ...d.assessments.map((a) => ({
    at: a.at,
    who: a.byName,
    what: `rated it ${RATING_WORDS[a.rating].toLowerCase()}${a.note ? `: “${a.note}”` : ''}`,
  })),
];

/**
 * Mandate inside the shell: the floor's intents, what the person holds, and one
 * intent with its statement, line of sight, the parts below and what it's bound to.
 * Pickers and opening other apps' things come in as functions from the entry.
 */
export function MandateApp({ api, floorName, floorKind, place: start, onPlace, pickDocument, pickEntity, openDocument, openEntity }: MandateAppProps) {
  const [place, setPlace] = useState<Place>(start);
  const [floor, setFloor] = useState<Floor>();
  const [yours, setYours] = useState<Yours>();
  const [detail, setDetail] = useState<Detail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<DialogName>();
  const [note, setNote] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [carry, setCarry] = useState<string[]>([]);
  const [picked, setPicked] = useState<EntityRef>();
  const [noEntities, setNoEntities] = useState('');

  /** Loads the rail, then whatever the place shows. */
  const refresh = useCallback(
    async (at: Place) => {
      setLoading(true);
      setError('');
      try {
        const [f, y] = await Promise.all([api.floor(), api.yours()]);
        setFloor(f);
        setYours(y);
        if (at.view === 'intent') setDetail(await api.intent(at.id));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  useEffect(() => void refresh(start), [refresh, start]);

  const go = (to: Place) => {
    setPlace(to);
    setNote('');
    setDetail((d) => (to.view === 'intent' && d?.intent.id === to.id ? d : undefined));
    onPlace?.(to);
    void refresh(to);
  };

  /** Runs a change to the open intent, shows what it answers, and refreshes the rail. Throws for a dialog to show. */
  const change = async (run: () => Promise<Detail>, said = '') => {
    setDetail(await run());
    setNote(said);
    const [f, y] = await Promise.all([api.floor(), api.yours()]);
    setFloor(f);
    setYours(y);
  };
  const act = async (run: () => Promise<Detail>, said = '') => {
    try {
      await change(run, said);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  // ---- a floor ----
  const card = (i: FloorItem | Summary, counts?: FloorItem['counts']) => {
    const mark = markOf(i);
    const rest = counts ? counts.parts - counts.atRisk - counts.blocked : 0;
    return (
      <Card
        key={i.id}
        heading={i.title}
        status={mark.status}
        statusLabel={mark.label}
        floorKind={i.floorKind}
        floorName={i.floorName}
        meta={[i.partOf ? `Part of ${i.partOf}` : '', holderWords(i), i.byDate ? `By ${dayName(i.byDate)}` : ''].filter(Boolean)}
        note={i.ratingNote}
        noteTone={i.rating === 'blocked' ? 'danger' : i.rating === 'at_risk' ? 'warning' : 'ink'}
        onOpen={() => go({ view: 'intent', id: i.id })}
        tally={
          counts?.parts ? (
            <Tally
              noun={['part below', 'parts below']}
              counts={[
                { status: 'running', n: rest, word: 'under way' },
                {
                  status: 'warning',
                  n: counts.atRisk,
                  word: 'at risk',
                  loud: true,
                },
                {
                  status: 'failed',
                  n: counts.blocked,
                  word: 'blocked',
                  loud: true,
                },
              ]}
            />
          ) : undefined
        }
      />
    );
  };

  const floorView = () => {
    if (!floor) return <State kind="loading" heading="Loading this floor’s intent" />;
    const empty = !floor.intents.length && !floor.drafts.length;
    return (
      <>
        <PageHead eyebrow={floorName || 'This floor'} heading="Intent" summary={floor.intents.length ? `${floor.intents.length} under way here.` : 'Nothing under way here yet.'} />
        {empty ? (
          <State
            heading={floor.can.create ? 'Set the first intent for this floor' : 'No intent on this floor yet'}
            body={
              floor.can.create
                ? 'Say what this floor means to achieve and why. Then pass parts of it down to the teams and people who’ll do it.'
                : 'When this floor’s leads set intent, or pass part of theirs down to you, it shows here.'
            }
            action={floor.can.create ? 'New intent' : undefined}
            onAction={() => setDialog('new')}
          />
        ) : null}
        {floor.intents.length ? <Cards>{floor.intents.map((i) => card(i, i.counts))}</Cards> : null}
        {floor.drafts.length ? (
          <Section label="Drafts" count={floor.drafts.length}>
            <Cards>{floor.drafts.map((i) => card(i))}</Cards>
          </Section>
        ) : null}
        {floor.closed.length ? (
          <Section label="Closed" count={floor.closed.length}>
            <Cards>{floor.closed.map((i) => card(i))}</Cards>
          </Section>
        ) : null}
      </>
    );
  };

  // ---- what you hold ----
  const yoursView = () => {
    if (!yours) return <State kind="loading" heading="Loading what you hold" />;
    const row = (i: Summary, status: StatusName, detail: string): ListItem => ({
      id: i.id,
      title: i.title,
      detail,
      status,
      ...(i.byDate ? { meta: `By ${dayName(i.byDate)}` } : {}),
    });
    const items: ListItem[] = [
      ...yours.passed.map((i) => ({
        ...row(i, 'needs', `${i.partOf ? `Part of ${i.partOf} · ` : ''}Say it back to accept it`),
        group: 'Passed to you',
      })),
      ...yours.recheck.map((i) => ({
        ...row(i, 'needs', `${i.partOf} has changed: check yours still fits`),
        group: 'Passed to you',
      })),
      ...yours.due.map((i) => ({
        ...row(i, 'needs', 'How is it going?'),
        group: 'Needs your judgement',
      })),
      ...yours.holding
        .filter((i) => !yours.due.some((d) => d.id === i.id) && !yours.recheck.some((d) => d.id === i.id))
        .map((i) => ({
          ...row(i, markOf(i).status, [i.partOf ? `Part of ${i.partOf}` : '', i.floorName, markOf(i).label].filter(Boolean).join(' · ')),
          group: 'You hold',
        })),
    ];
    return (
      <>
        <PageHead eyebrow="For you" heading="What you hold" summary={yours.passed.length ? `${yours.passed.length} waiting for your back-brief.` : 'Your parts, on every floor.'} />
        <List
          label="What you hold"
          noun={['intent', 'intents']}
          items={items}
          empty="Nothing passed to you yet. When someone passes you part of their intent, it shows here."
          onOpen={(item) => go({ view: 'intent', id: item.id })}
        />
      </>
    );
  };

  // ---- one intent ----
  const branch = (b: Branch): ReactNode => {
    const mark = markOf(b);
    const label = (
      <>
        <span className="mandate-branch-title">
          {b.mainEffort ? (
            <span className="mandate-badge" title="Main effort">
              Main effort
            </span>
          ) : null}
          {b.title}
        </span>
        <span className="mandate-quiet">
          {holderWords(b)}
          {b.floorKind === 'team' ? ` · ${b.floorName}` : ''}
          {b.ratingNote ? ` · ${b.ratingNote}` : ''}
        </span>
      </>
    );
    const ownChild = detail?.can.pass && b.life !== 'withdrawn' && b.parent === detail.intent.id;
    return (
      <li key={b.id} className="mandate-branch" style={{ '--floor': floorMark[b.floorKind] } as CSSProperties}>
        <div className="mandate-branch-row">
          {b.sight === 'full' ? (
            <button type="button" className="mandate-branch-open" onClick={() => go({ view: 'intent', id: b.id })}>
              {label}
            </button>
          ) : (
            <div className="mandate-branch-open" title="You see its title and how it’s going, not its statement">
              {label}
            </div>
          )}
          <Status status={mark.status} label={mark.label} />
          {ownChild ? (
            <Button kind="ghost" size="sm" onPress={() => void act(() => api.mainEffort(b.id, !b.mainEffort).then(() => api.intent(detail.intent.id)))}>
              {b.mainEffort ? 'Clear main effort' : 'Main effort'}
            </Button>
          ) : null}
        </div>
        {b.below.length ? <ul className="mandate-tree">{b.below.map(branch)}</ul> : null}
      </li>
    );
  };

  const statement = (s: Statement) => {
    const parts = PARTS.filter((p) => (p.key === 'keyTasks' ? s.keyTasks.length : s[p.key]));
    if (!parts.length) return <Note>Nothing written yet.</Note>;
    return (
      <dl className="mandate-statement">
        {parts.map((p) => (
          <div key={p.key}>
            <dt>{p.label}</dt>
            <dd>
              <Prose value={p.key === 'keyTasks' ? s.keyTasks.map((t) => `- ${t}`).join('\n') : s[p.key]} />
            </dd>
          </div>
        ))}
      </dl>
    );
  };

  /** What the person can do with it now, most pressing first: the page head shows two and puts the rest in ⋯. */
  const actionsFor = (d: Detail, written: boolean) => {
    const { intent, can } = d;
    const acts: (PageAction & { run: () => void })[] = [];
    const add = (id: string, label: string, kind: ButtonKind, run: () => void) => acts.push({ id, label, kind, run });
    if (can.backBrief && intent.life === 'passed') {
      add('back-brief', 'Back-brief', 'primary', () => setDialog('accept'));
      add('concern', 'Raise a concern', 'secondary', () => setDialog('concern'));
    }
    if (can.backBrief && d.recheck) add('confirm', 'Confirm it still stands', 'primary', () => setDialog('accept'));
    if (can.edit) add('edit', intent.life === 'draft' ? 'Write it' : 'Revise', intent.life === 'draft' && !written ? 'primary' : 'secondary', () => setDialog('edit'));
    if (can.edit && unissued(d)) add('issue', 'Issue', written ? 'primary' : 'secondary', () => void act(() => api.issue(intent.id), 'Issued.'));
    if (can.assess) add('assess', 'How is it going?', d.assessmentDue ? 'primary' : 'secondary', () => setDialog('assess'));
    if (can.pass) add('pass', 'Pass down', 'secondary', () => void openPass());
    if (can.achieve) add('achieve', 'Close as achieved', 'secondary', () => setDialog('achieve'));
    if (can.withdraw) add('withdraw', 'Withdraw', 'ghost', () => setDialog('withdraw'));
    // The primary leads, so it's never folded into ⋯.
    return [...acts.filter((a) => a.kind === 'primary'), ...acts.filter((a) => a.kind !== 'primary')];
  };

  /** What this intent needs from the person now, said once at the top. */
  const attention = (d: Detail) => {
    const { intent, can } = d;
    let words = '';
    if (can.backBrief && intent.life === 'passed') words = `${d.passed?.by ?? 'Someone'} passed you this. Read the line of sight, then say it back in your own words to accept it.`;
    else if (can.backBrief && d.recheck) words = `${d.lineOfSight.at(-1)?.title ?? 'The intent above'} has changed since you back-briefed. Check yours still fits.`;
    else if (can.edit && intent.life === 'draft') words = 'A draft: say its purpose and end state, then issue it.';
    else if (can.edit && unissued(d)) words = 'You’ve changed it since it was last issued. Issue it to make it the next version.';
    else if (d.assessmentDue) words = 'How is it going? Your last judgement is older than its rhythm.';
    else if (d.ended) words = `${markOf(intent).label} ${relativeTime(d.ended.at)}.${d.ended.reason ? ` ${d.ended.reason}` : ''}`;
    const needs = (can.backBrief && (intent.life === 'passed' || d.recheck)) || d.assessmentDue;
    return words ? <Notice tone={needs ? 'needs' : 'info'}>{words}</Notice> : null;
  };

  const bindEntity = async () => {
    if (!pickEntity) return;
    try {
      setPicked(await pickEntity());
      setDialog('role');
    } catch (err) {
      if ((err as Error).name === 'IntentCancelled') return;
      // Explain, never hide: the control stays, saying why it can't be used yet.
      setNoEntities('Linking to entities arrives with Data Atlas.');
    }
  };

  const addDocument = async () => {
    if (!pickDocument || !detail) return;
    const id = detail.intent.id;
    try {
      const doc = await pickDocument();
      await act(() => api.addDocument(id, doc));
    } catch (err) {
      if ((err as Error).name === 'IntentCancelled') return;
      setNote((err as Error).message);
    }
  };

  const findTargets = async (q: string) => {
    if (!detail) return;
    try {
      const found = await api.targets(detail.intent.id, q);
      setTargets([...found.teams, ...found.people]);
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const openPass = async () => {
    setTargets([]);
    setCarry([]);
    setDialog('pass');
    await findTargets('');
  };

  const intentView = () => {
    const d = detail;
    if (!d)
      return {
        main: <State kind="loading" heading="Loading the intent" />,
        aside: undefined,
      };
    const { intent, can } = d;
    const mark = markOf(intent);
    const latest = d.assessments[0];
    const byRole = Object.keys(ROLE_WORDS)
      .map((role) => ({
        role,
        items: d.entities.filter((e) => e.role === role),
      }))
      .filter((g) => g.items.length);
    const meta = [
      intent.floorName,
      `held by ${holderWords(intent)}`,
      d.passed ? `passed down by ${d.passed.by}` : '',
      d.issued ? `version ${d.issued.version}, issued ${relativeTime(d.issued.at)}` : 'not issued yet',
      intent.byDate ? `by ${dayName(intent.byDate)}` : '',
    ].filter(Boolean);
    // Ready to issue once the draft says why and what done looks like.
    const draft = d.draft ?? d.statement;
    const written = Boolean(draft.purpose.trim() && draft.endState.trim());
    const actions = actionsFor(d, written);
    const main = (
      <>
        <PageHead
          trail={d.lineOfSight.map((a) => ({ id: a.id, label: a.title }))}
          onTrail={(step) => go({ view: 'intent', id: step.id })}
          eyebrow={intent.mainEffort ? 'Main effort' : intent.parent ? 'Part' : 'Intent'}
          heading={intent.title}
          summary={meta.join(' · ')}
          actions={actions}
          onAction={(a) => actions.find((x) => x.id === a.id)?.run()}
        >
          <Status status={mark.status} label={mark.label} />
        </PageHead>
        {attention(d)}
        <Note live>{note}</Note>
        {statement(d.statement)}
        {latest ? (
          <Section label={`Latest judgement · ${latest.byName} · ${relativeTime(latest.at)}`} count={-1}>
            <p className="mandate-judgement">
              <b>{RATING_WORDS[latest.rating]}.</b> {latest.note}
            </p>
          </Section>
        ) : null}
        <Section label="Passed down" count={d.below.length} limit={0}>
          {d.below.length ? (
            <ul className="mandate-tree mandate-tree-top">{d.below.map(branch)}</ul>
          ) : (
            <Note>{can.pass ? 'Nothing passed down yet. Pass parts of it to the teams below, or to people on this floor.' : 'Nothing passed down.'}</Note>
          )}
        </Section>
      </>
    );
    const aside = (
      <div className="mandate-side">
        {d.lineOfSight.length ? (
          <Section label="Line of sight" count={-1} limit={0}>
            <Path
              steps={
                [
                  ...d.lineOfSight.map((a) => ({
                    id: a.id,
                    floor: a.floorKind,
                    title: a.title,
                    line: a.purpose || a.mission,
                    ...(a.mainEffort ? { mark: 'Main effort' } : {}),
                  })),
                  { floor: intent.floorKind, title: 'This', here: true },
                ] satisfies PathStep[]
              }
              onOpen={(step) => go({ view: 'intent', id: step.id! })}
            />
          </Section>
        ) : null}
        <Section label="Bound to" count={d.entities.length} limit={0}>
          {byRole.length ? (
            byRole.map((g) => (
              <div key={g.role} className="mandate-role">
                <span className="mandate-quiet">{ROLE_WORDS[g.role] ?? g.role}</span>
                <Refs
                  refs={g.items.map((e) => ({
                    ...e.entity,
                    ...(e.from ? { from: e.from } : {}),
                  }))}
                  onOpen={(ref) => openEntity?.(g.items.find((e) => e.entity.id === ref.id)!.entity)}
                  onRemove={can.bind ? (ref) => void act(() => api.unbindEntity(intent.id, ref.id, g.role)) : undefined}
                />
              </div>
            ))
          ) : (
            <Note>No entities yet: the ships, places and resources it’s about.</Note>
          )}
          {can.bind ? (
            <div>
              <Button kind="ghost" size="sm" disabled={Boolean(noEntities)} reason={noEntities || undefined} onPress={() => void bindEntity()}>
                Bind an entity
              </Button>
            </div>
          ) : null}
        </Section>
        <Section label="Context documents" count={d.documents.length} limit={0}>
          <Refs
            empty="No documents yet."
            refs={d.documents.map((doc) => ({
              ...doc.document,
              kind: 'document' as const,
              ...(doc.from ? { from: doc.from } : {}),
            }))}
            onOpen={(ref) => openDocument?.(d.documents.find((doc) => doc.document.id === ref.id)!.document)}
            onRemove={can.bind ? (ref) => void act(() => api.removeDocument(intent.id, d.documents.find((doc) => doc.document.id === ref.id)!.document)) : undefined}
          />
          {can.bind && pickDocument ? (
            <div>
              <Button kind="ghost" size="sm" onPress={() => void addDocument()}>
                Add a document
              </Button>
            </div>
          ) : null}
        </Section>
        <Section label="History" count={-1} limit={0}>
          <Timeline items={history(d)} />
        </Section>
      </div>
    );
    return { main, aside };
  };

  // ---- dialogs ----
  const submitNew: DialogSubmit = async (values) => {
    const made = await api.create(values.title ?? '', floorName);
    go({ view: 'intent', id: made.id });
    setDialog('edit');
    return false as const;
  };
  const submitEdit: DialogSubmit = async (values) => {
    const d = detail!;
    const s: Partial<Statement> = {};
    for (const p of PARTS) {
      if (p.key === 'keyTasks') s.keyTasks = (values.keyTasks ?? '').split('\n');
      else s[p.key] = values[p.key] ?? '';
    }
    await change(
      () =>
        api.edit(d.intent.id, {
          title: values.title ?? '',
          statement: s,
          byDate: values.byDate?.trim() || null,
        }),
      'Saved. Issue it when it’s ready.',
    );
  };
  const submitPass: DialogSubmit = async (values) => {
    const d = detail!;
    await api.pass(d.intent.id, {
      to: values.to ?? '',
      title: values.title ?? '',
      ...(values.purpose?.trim() ? { purpose: values.purpose } : {}),
      ...(values.byDate?.trim() ? { byDate: values.byDate.trim() } : {}),
      carry: {
        entities: carry.filter((c) => c.startsWith('e|')).map((c) => c.slice(2)),
        documents: carry.filter((c) => c.startsWith('d|')).map((c) => c.slice(2)),
      },
    });
    await change(() => api.intent(d.intent.id), 'Passed down. It’s under way once they back-brief it.');
  };
  const submitAccept: DialogSubmit = async (values) => {
    await change(
      () =>
        api.backBrief(detail!.intent.id, {
          words: values.words ?? '',
          outcome: 'accepted',
        }),
      'Accepted. It’s yours.',
    );
  };
  const submitConcern: DialogSubmit = async (values) => {
    await change(
      () =>
        api.backBrief(detail!.intent.id, {
          words: values.words ?? '',
          concern: values.concern ?? '',
          outcome: 'concern',
        }),
      'Sent back with your concern.',
    );
  };
  const submitAssess: DialogSubmit = async (values) => {
    await change(() => api.assess(detail!.intent.id, values.rating as Rating, values.note ?? ''), 'Thanks. Whoever passed it down sees it.');
  };
  const submitAchieve: DialogSubmit = async () => {
    await change(() => api.achieve(detail!.intent.id), 'Closed as achieved.');
  };
  const submitWithdraw: DialogSubmit = async (values) => {
    await change(() => api.withdraw(detail!.intent.id, values.reason ?? ''), 'Withdrawn.');
  };
  const submitRole: DialogSubmit = async (values) => {
    const p = picked!;
    await change(() => api.bindEntity(detail!.intent.id, p, values.role ?? 'subject'));
    setPicked(undefined);
  };

  const close = () => setDialog(undefined);
  const dialogs = () => {
    const d = detail;
    switch (dialog) {
      case 'new':
        return (
          <Dialog
            open
            onClose={close}
            eyebrow={floorName || 'This floor'}
            heading="New intent"
            summary={floorKind === 'personal' ? 'Only you see intent on your own floor.' : 'Everyone on this floor will read it once it’s issued. Its leads hold it.'}
            actionLabel="Start writing"
            busyLabel="Making…"
            onSubmit={submitNew}
            fields={<TextField name="title" label="Name" hint="What people will call it: Operation Alpha, Winter readiness." required maxLength={140} />}
          />
        );
      case 'edit': {
        if (!d?.draft) return null;
        const s = d.draft;
        return (
          <Dialog
            open
            onClose={close}
            size="read"
            eyebrow={d.intent.floorName}
            heading={d.intent.life === 'draft' ? 'Write the intent' : 'Revise the intent'}
            summary={
              d.intent.version
                ? 'Saving keeps it as a draft. Issue it to make it the next version; the parts below are asked to check theirs still fits.'
                : 'Purpose and end state are needed to issue it.'
            }
            actionLabel="Save"
            busyLabel="Saving…"
            onSubmit={submitEdit}
            fields={
              <>
                <TextField name="title" label="Name" required maxLength={140} defaultValue={d.intent.title} />
                {PARTS.map((p) => (
                  <Editor
                    key={p.key}
                    name={p.key}
                    label={p.label}
                    hint={p.hint}
                    required={p.required}
                    optional={!p.required}
                    rows={p.key === 'mission' ? 2 : 3}
                    guide={p.guide}
                    defaultValue={p.key === 'keyTasks' ? s.keyTasks.join('\n') : s[p.key]}
                  />
                ))}
                <DateField name="byDate" label="Done by" optional empty="No date" defaultValue={d.intent.byDate ?? ''} />
              </>
            }
          />
        );
      }
      case 'pass': {
        if (!d) return null;
        const options: SelectOption[] = [
          ...d.entities.map((e) => ({
            value: `e|${e.entity.id}|${e.role}`,
            label: e.entity.label || 'An entity',
            detail: ROLE_WORDS[e.role] ?? e.role,
          })),
          ...d.documents.map((x) => ({
            value: `d|${x.document.app}|${x.document.id}`,
            label: x.document.title,
            detail: 'Document',
          })),
        ];
        return (
          <Dialog
            open
            onClose={close}
            size="read"
            eyebrow={`Pass down from ${d.intent.title}`}
            heading="Who holds this part?"
            summary="A team directly below this floor, or someone on it. They say it back in their own words before it’s under way."
            actionLabel="Pass down"
            busyLabel="Passing…"
            onSubmit={submitPass}
            fields={
              <>
                <TextField label="Find a team or person" optional maxLength={100} onChange={(v) => void findTargets(v)} />
                <Select
                  name="to"
                  label="To"
                  required
                  placeholder="Choose who"
                  options={targets.map((t) => ({
                    value: t.to,
                    label: t.you ? `${t.name} (you)` : t.name,
                    detail: t.to.startsWith('team:') ? 'Team' : (t.email ?? ''),
                  }))}
                />
                <TextField name="title" label="Their part" hint="What they’re to achieve, in a line." required maxLength={140} />
                <Editor name="purpose" label="Why it matters to the whole" optional rows={2} guide="2 sentences" />
                <DateField name="byDate" label="Done by" optional empty="No date" />
                {options.length ? (
                  <CheckboxGroup label="Carry down" hint="What their part starts bound to." optional value={carry} onChange={setCarry}>
                    {options.map((o) => (
                      <Checkbox key={o.value} value={o.value} detail={o.detail}>
                        {o.label}
                      </Checkbox>
                    ))}
                  </CheckboxGroup>
                ) : null}
              </>
            }
          />
        );
      }
      case 'accept':
        return d ? (
          <Dialog
            open
            onClose={close}
            size="read"
            eyebrow={d.recheck ? 'Confirm your back-brief' : 'Back-brief'}
            heading={d.intent.title}
            summary={d.lineOfSight.length ? `Part of ${d.lineOfSight.at(-1)!.title}: ${d.lineOfSight.at(-1)!.purpose || d.lineOfSight.at(-1)!.endState}` : undefined}
            actionLabel={d.recheck ? 'It still stands' : 'Accept this part'}
            busyLabel="Sending…"
            onSubmit={submitAccept}
            fields={<Editor name="words" label="Say it back in your own words" hint="What you’ll achieve, and why it matters to the whole." required rows={4} guide="3 sentences" />}
          />
        ) : null;
      case 'concern':
        return d ? (
          <Dialog
            open
            onClose={close}
            size="read"
            eyebrow="Raise a concern"
            heading={d.intent.title}
            summary="It goes back to whoever passed it down, who can revise it or answer."
            actionLabel="Send it back"
            busyLabel="Sending…"
            onSubmit={submitConcern}
            fields={
              <>
                <Editor name="words" label="Say it back in your own words" required rows={3} guide="3 sentences" />
                <Editor name="concern" label="What doesn’t fit" required rows={3} guide="3 sentences" />
              </>
            }
          />
        ) : null;
      case 'assess':
        return d ? (
          <Dialog
            open
            onClose={close}
            eyebrow={d.intent.title}
            heading="How is it going?"
            summary="Against its end state. Whoever passed it down sees this."
            actionLabel="Say so"
            busyLabel="Saving…"
            onSubmit={submitAssess}
            fields={
              <>
                <Select name="rating" label="It’s" required options={RATING_OPTIONS} defaultValue={d.intent.rating ?? null} />
                <TextField name="note" label="Why" optional multiline rows={2} maxLength={1000} />
              </>
            }
          />
        ) : null;
      case 'achieve':
        return d ? (
          <Dialog
            open
            onClose={close}
            eyebrow={d.intent.title}
            heading="Close it as achieved?"
            summary="Anything still open below it closes with it."
            actionLabel="Close as achieved"
            busyLabel="Closing…"
            onSubmit={submitAchieve}
          />
        ) : null;
      case 'withdraw':
        return d ? (
          <Dialog
            open
            onClose={close}
            danger
            eyebrow={d.intent.title}
            heading="Withdraw it?"
            summary="Every part still open below it is withdrawn too, and its holders are told."
            actionLabel="Withdraw"
            busyLabel="Withdrawing…"
            onSubmit={submitWithdraw}
            fields={<TextField name="reason" label="Why" optional multiline rows={2} maxLength={1000} />}
          />
        ) : null;
      case 'role':
        return picked ? (
          <Dialog
            open
            onClose={() => {
              setPicked(undefined);
              close();
            }}
            eyebrow={picked.label}
            heading="What part does it play?"
            actionLabel="Bind it"
            busyLabel="Binding…"
            onSubmit={submitRole}
            fields={<Select name="role" label="Role" required options={ROLE_OPTIONS} defaultValue="subject" />}
          />
        ) : null;
      default:
        return null;
    }
  };

  const waiting = (yours?.passed.length ?? 0) + (yours?.recheck.length ?? 0);
  const rail = (
    <>
      <RailLink icon="compass" label="Intent" count={floor?.intents.length || undefined} current={place.view === 'floor'} onPress={() => go({ view: 'floor' })} />
      {floor?.drafts.length ? <RailLink icon="document" label="Drafts" count={floor.drafts.length} onPress={() => go({ view: 'floor' })} /> : null}
      <RailLink icon="inbox" label="What you hold" count={waiting || undefined} current={place.view === 'yours'} onPress={() => go({ view: 'yours' })} />
      {floor?.can.create ? (
        <div className="mandate-rail-act">
          <Button kind="ghost" size="sm" onPress={() => setDialog('new')}>
            New intent
          </Button>
        </div>
      ) : null}
    </>
  );
  let main: ReactNode;
  let aside: ReactNode;
  if (error) main = <State kind="error" heading="Couldn’t load Mandate" body={error} action="Try again" onAction={() => void refresh(place)} />;
  else if (place.view === 'yours') main = yoursView();
  else if (place.view === 'intent') ({ main, aside } = intentView());
  else main = floorView();
  return (
    <>
      <AppFrame
        app={{ name: 'Mandate', icon: 'compass' }}
        onFront={() => go({ view: 'floor' })}
        rail={rail}
        railLabel="Intent"
        aside={aside}
        busy={loading}
        screen={place.view === 'intent' ? `intent:${place.id}` : place.view}
      >
        {main}
      </AppFrame>
      {dialogs()}
    </>
  );
}
