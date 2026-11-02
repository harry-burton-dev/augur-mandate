import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Heading, List, TextField, type ListItem } from '@augur/app-kit';
import type { IntentRef, MandateApi } from './api.js';

interface Pickable {
  id: string;
  title: string;
  detail: string;
}

export interface MandatePickerProps {
  api: MandateApi;
  purpose?: string;
  onPick: (intent: IntentRef) => void;
  onCancel: () => void;
}

/**
 * Mandate answering `aim.pick` for another app: an intent under way on this
 * floor or held by the person, or one found by the words of its title. A
 * briefing tool asks this to bound what it gathers to one intent and its tree.
 */
export function MandatePicker({ api, purpose, onPick, onCancel }: MandatePickerProps) {
  const [query, setQuery] = useState('');
  const [intents, setIntents] = useState<Pickable[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** What's typed, or else what's under way here and what the person holds. */
  const list = useCallback(
    async (q: string) => {
      const n = ++asked.current;
      setLoading(true);
      setFailure('');
      try {
        let found: Pickable[];
        if (q.trim()) found = (await api.search(q.trim())).results;
        else {
          const [floor, yours] = await Promise.all([api.floor(), api.yours()]);
          const seen = new Set<string>();
          found = [...floor.intents.map((i) => ({ i, where: 'On this floor' })), ...yours.holding.map((i) => ({ i, where: 'You hold' }))]
            .filter(({ i }) => !seen.has(i.id) && seen.add(i.id))
            .map(({ i, where }) => ({
              id: i.id,
              title: i.title,
              detail: [where, i.partOf ? `Part of ${i.partOf}` : '', i.floorName].filter(Boolean).join(' · '),
            }));
        }
        if (n === asked.current) setIntents(found);
      } catch (err) {
        if (n === asked.current) setFailure((err as Error).message);
      } finally {
        if (n === asked.current) setLoading(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void list('');
    return () => clearTimeout(timer.current);
  }, [list]);

  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void list(q), 200);
  };

  const rows: ListItem[] = intents.map((i) => ({
    id: i.id,
    title: i.title,
    detail: i.detail,
    icon: 'compass',
  }));
  return (
    <div className="mandate-picker">
      <Heading eyebrow="Pick from Mandate" heading={purpose || 'Pick an intent'} summary="One under way here or that you hold, or find one by its title." />
      <TextField label="Find" placeholder="Words in its title" value={query} onChange={search} />
      <List
        label="Intents to pick from"
        density="compact"
        noun={['intent', 'intents']}
        items={rows}
        loading={loading}
        error={failure}
        empty={query.trim() ? 'Nothing you can read matches that.' : 'Nothing under way here, and nothing you hold. Type to find one anywhere you can read.'}
        onRetry={() => void list(query)}
        onOpen={(item) => {
          const i = intents.find((x) => x.id === item.id);
          if (i)
            onPick({
              kind: 'intent',
              app: 'mandate',
              id: i.id,
              title: i.title,
            });
        }}
      />
      <div>
        <Button kind="ghost" size="sm" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
