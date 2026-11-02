import { useCallback, useEffect, useState } from 'react';
import { Button, Facts, List, State, type Fact, type ListItem } from '@augur/app-kit';
import type { HomeGlance, MandateApi } from './api.js';

/** How many intents the card names: it's a glance, not a list. */
const NAMED = 2;

export interface MandateGlanceProps {
  api: MandateApi;
  onOpen: (id: string) => void;
  onOpenYours: () => void;
}

/**
 * Mandate's card on Home: what's waiting on the person (parts passed to them to
 * say back, or ones whose parent changed), and how this floor's intent stands.
 */
export function MandateGlance({ api, onOpen, onOpenYours }: MandateGlanceProps) {
  const [glance, setGlance] = useState<HomeGlance>();
  const [failure, setFailure] = useState('');
  const load = useCallback(async () => {
    setFailure('');
    try {
      setGlance(await api.home());
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  if (failure) return <State kind="error" heading="Couldn’t reach Mandate" body={failure} action="Try again" onAction={() => void load()} />;
  if (!glance) return <Facts loading count={3} />;
  const facts: Fact[] = [
    { value: glance.waiting.length, label: 'Waiting on you' },
    { value: glance.floor.active, label: 'Under way here' },
    ...(glance.floor.atRisk || glance.floor.blocked
      ? [
          {
            value: glance.floor.atRisk + glance.floor.blocked,
            label: 'At risk or blocked',
          },
        ]
      : []),
  ];
  const rows: ListItem[] = glance.waiting.slice(0, NAMED).map((i) => ({
    id: i.id,
    title: i.title,
    detail: i.partOf ? `Part of ${i.partOf}` : i.floorName,
    status: 'needs',
    icon: 'compass',
  }));
  return (
    <div className="mandate-glance">
      <Facts items={facts} />
      {rows.length ? <List label="Waiting on you" density="compact" bar={false} items={rows} onOpen={(item) => onOpen(item.id)} /> : null}
      <div>
        <Button kind="secondary" size="sm" onPress={onOpenYours}>
          {`What you hold${glance.holding ? ` (${glance.holding})` : ''}`}
        </Button>
      </div>
    </div>
  );
}
