import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useEffect, useState } from 'react';
import type { FlowBaseSnapshot } from '../../lib/flows/flow-change-presentation';

export function useFlowBaseSnapshot(
  flowId: string | undefined,
  enabled: boolean,
): FlowBaseSnapshot | undefined {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<FlowBaseSnapshot>();

  useEffect(() => {
    if (!flowId) {
      setSnapshot(undefined);
      return;
    }
    if (!enabled) {
      setSnapshot((current) => (current?.id === flowId ? current : undefined));
      return;
    }

    // Never render Flow A's snapshot under Flow B while the new cache/query resolves.
    setSnapshot((current) => (current?.id === flowId ? current : undefined));

    let cancelled = false;
    void import('../../lib/trpc')
      .then(({ trpc, trpcClient }) => {
        const queryFlow = () => trpcClient.flows.get.query({ id: flowId });
        return queryClient.fetchQuery({
          queryKey: getQueryKey(trpc.flows.get, { id: flowId }, 'query'),
          queryFn: queryFlow,
          staleTime: 30_000,
        });
      })
      .then((flow) => {
        if (cancelled) return;
        setSnapshot({
          id: flow.id,
          name: flow.name,
          graph: flow.graph,
          versionNumber: flow.version_number ?? undefined,
        });
      })
      .catch(() => {
        if (!cancelled) setSnapshot(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, flowId, queryClient]);

  return snapshot?.id === flowId ? snapshot : undefined;
}
