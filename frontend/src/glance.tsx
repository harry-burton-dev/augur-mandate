import { useMemo } from 'react';
import { Button, Facts, List, State, useData, type AppSurfaceProps, type Fact, type ListItem } from '@augur/app-kit';
import type { MountContext } from '@augur/mfe-sdk';
import { MandateApi } from './api.js';
import { AIM_OPEN, MANDATE_OPEN } from './intents.js';

/** How many intents the card names: it's a glance, not a list. */
const NAMED = 2;

/**
 * Mandate's card on Home: what's waiting on the person (parts passed to them to
 * say back, or ones whose parent changed), and how this floor's intent stands.
 * Opening anything raises an intent, so the shell opens Mandate at it.
 */
export function MandateGlance({ ctx }: AppSurfaceProps<MountContext>) {
  const api = useMemo(() => new MandateApi(ctx), [ctx]);
  const { data: glance, error, refresh } = useData(['home'], (signal) => api.home(signal));
  const onOpen = (id: string) => void ctx.raise({ type: AIM_OPEN, payload: { id } });
  const onOpenYours = () => void ctx.raise({ type: MANDATE_OPEN, payload: { path: '/yours' } });

  if (error && !glance) return <State kind="error" heading="Couldn’t reach Mandate" body={error.message} action={error.retryable ? 'Try again' : undefined} onAction={refresh} />;
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
