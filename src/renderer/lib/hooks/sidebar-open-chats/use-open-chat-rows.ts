import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { trpc } from '../../trpc';

type PollingConfig = Record<'CHAT_POLL_INTERVAL_MS', number>;

/** Rows for the chats open in split panes (`chatPaneMap`), or the selected chat in single view, so
 *  each keeps a sidebar row even when it is older than every loaded page. */
export function useOpenChatRows(
  chatPaneMap: ReadonlyMap<string, number> | null,
  selectedChatId: string | null,
  timing: PollingConfig,
) {
  const ids = useMemo(() => {
    if (chatPaneMap) return [...chatPaneMap.keys()].sort();
    return selectedChatId ? [selectedChatId] : [];
  }, [chatPaneMap, selectedChatId]);
  const { data } = trpc.chats.listByIds.useQuery(
    { ids },
    {
      enabled: ids.length > 0,
      placeholderData: keepPreviousData,
      refetchInterval: timing.CHAT_POLL_INTERVAL_MS,
    },
  );
  // The previous id set's rows stand in while a new set loads; drop any chat no longer open.
  return useMemo(() => (data ?? []).filter((chat) => ids.includes(chat.id)), [data, ids]);
}
