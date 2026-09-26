import { useMemo } from 'react';
import { trpc } from '../trpc';

type SidebarChat = { id: string };
type PollingConfig = Record<'CHAT_POLL_INTERVAL_MS', number>;

export function usePendingPlanIds(
  chats: readonly SidebarChat[],
  liveApprovals: ReadonlyMap<string, string>,
  timing: PollingConfig,
): Set<string> {
  const chatIds = useMemo(() => chats.map((chat) => chat.id), [chats]);
  const { data: persistedApprovals } = trpc.chats.getPendingPlanApprovals.useQuery(
    { chatIds },
    {
      enabled: chatIds.length > 0,
      refetchInterval: timing.CHAT_POLL_INTERVAL_MS,
      structuralSharing: true,
    },
  );

  return useMemo(() => {
    const ids = new Set(liveApprovals.values());
    if (Array.isArray(persistedApprovals)) {
      for (const approval of persistedApprovals) ids.add(approval.chatId);
    }
    return ids;
  }, [liveApprovals, persistedApprovals]);
}
