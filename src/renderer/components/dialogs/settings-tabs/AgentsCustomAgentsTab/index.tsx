import { type ReactElement, useCallback } from 'react';
import { toast } from 'sonner';
import { Bot } from 'lucide-react';
import { showCopyResultToast } from '@/lib/copy-across-toast';
import { trpc } from '@/lib/trpc';
import { type CopyMutationInput, ResourceSettingsTab } from '../ResourceSettingsTab';

// Reason: thin wrappers bound to separately typed tRPC routers; a shared generic adds code.
// fallow-ignore-next-line code-duplication
const AGENTS_CONFIG = {
  noun: 'agents',
  emptyIcon: Bot,
  emptyTitle: 'No custom agents yet',
  emptyBody: 'Ask your AI to make one and it shows up here.',
  usage: (name: string) =>
    `Ask your AI to use the ${name} agent, or it will call on it when needed.`,
} as const;

export function AgentsCustomAgentsTab(): ReactElement {
  const {
    data: rawAgents,
    isLoading,
    refetch,
  } = trpc.agents.getAggregatedAgentInfo.useQuery(undefined);
  const agents = Array.isArray(rawAgents) ? rawAgents : [];

  const copyAcrossMutation = trpc.agents.copyAcross.useMutation({
    onSuccess: (res) => {
      showCopyResultToast(res, 'agent');
      refetch();
    },
    onError: (error) => toast.error(error.message || 'Failed to copy'),
  });

  const handleCopyAcross = useCallback(
    ({ items, ...rest }: CopyMutationInput) =>
      copyAcrossMutation.mutate({ agents: items, ...rest }),
    [copyAcrossMutation],
  );

  return (
    <ResourceSettingsTab
      config={AGENTS_CONFIG}
      items={agents}
      isLoading={isLoading}
      copyAcross={{ noun: 'agent', onCopy: handleCopyAcross }}
    />
  );
}
