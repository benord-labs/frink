import { useQuery } from '@tanstack/react-query';
import type { FlowChangePresentation } from '../../../../shared/types/flows/flow-change-presentation';
import { type FlowVersionKey, type FlowVersionPair, stepDiffVersionKey } from './index';

async function loadVersionPair({
  flowId,
  baseVersionNumber,
}: FlowVersionKey): Promise<FlowVersionPair | null> {
  // Lazy so chat cards that never diff do not pull the IPC client into their module graph.
  const { trpcClient } = await import('../../trpc');
  const [before, after] = await Promise.all([
    trpcClient.flows.getVersion.query({ flowId, versionNumber: baseVersionNumber }),
    trpcClient.flows.getVersion.query({ flowId, versionNumber: baseVersionNumber + 1 }),
  ]);
  return before && after ? { before: before.graph, after: after.graph } : null;
}

/** The saved versions behind an applied step update; undefined while loading or when unavailable. */
export function useFlowVersionPair(
  presentation: FlowChangePresentation,
): FlowVersionPair | undefined {
  const key = stepDiffVersionKey(presentation);
  const { data } = useQuery({
    queryKey: ['flow-step-diff', key?.flowId, key?.baseVersionNumber],
    queryFn: () => (key ? loadVersionPair(key) : null),
    enabled: key !== undefined,
    // Version rows are immutable, so a loaded pair never goes stale.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return data ?? undefined;
}
