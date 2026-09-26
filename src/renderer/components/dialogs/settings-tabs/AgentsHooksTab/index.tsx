import { Zap } from 'lucide-react';
import type { ReactElement } from 'react';
import { trpc } from '@/lib/trpc';
import { ResourceSettingsTab } from '../ResourceSettingsTab';

const HOOKS_CONFIG = {
  noun: 'hooks',
  emptyIcon: Zap,
  emptyTitle: 'No hooks yet',
  emptyBody: 'When you add one to your coding tool, it shows up here.',
} as const;

export function AgentsHooksTab(): ReactElement {
  const { data: rawHooks, isLoading } = trpc.hooks.getAggregatedHookInfo.useQuery(undefined);
  const hooks = Array.isArray(rawHooks) ? rawHooks : [];

  return <ResourceSettingsTab config={HOOKS_CONFIG} items={hooks} isLoading={isLoading} />;
}
