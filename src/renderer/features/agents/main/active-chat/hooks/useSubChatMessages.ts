import type { UIMessage } from 'ai';
import { useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appStore } from '../../../../../lib/jotai-store';
import { perfMark } from '../../../../../lib/perf/marks';
import { trpc, trpcClient } from '../../../../../lib/trpc';
import {
  perSubChatMessageIdsAtomFamily,
  prependOlderMessagesAtom,
} from '../../../stores/message-store';

const INITIAL_PAGE_SIZE = 20;
const LOAD_OLDER_PAGE_SIZE = 20;

/** Stable empty slice when the query has no data — avoids new [] each render breaking useMemo consumers. */
const EMPTY_MESSAGES: UIMessage[] = [];

export type UseSubChatMessagesResult = {
  /** Initial page of messages (last N). Empty until query resolves. */
  messages: UIMessage[];
  /** True while the initial fetch is in progress. */
  isLoading: boolean;
  /** True while any fetch (initial or background refetch) is in progress. */
  isFetching: boolean;
  /** True while a "load older" request is in flight. */
  isLoadingOlder: boolean;
  /** Whether there are older messages to load. */
  hasMore: boolean;
  /** Load the next page of older messages. No-op if streaming or already loading. */
  loadOlder: () => Promise<void>;
  /** Error from initial fetch (if any). */
  error: Error | null;
  /** Error from loadOlder (if any). Cleared on next successful loadOlder or refetch. */
  loadOlderError: Error | null;
  /** Refetch initial page (e.g. for retry after error). */
  refetch: () => void;
};

/**
 * Fetches paginated messages for a sub-chat. Initial load returns last N messages.
 * loadOlder() fetches the next page and prepends to the store. Gate loadOlder when streaming.
 */
export function useSubChatMessages(
  subChatId: string | null,
  options: {
    /** When true, loadOlder() is a no-op (avoids race with sync). */
    isStreaming?: boolean;
  } = {},
): UseSubChatMessagesResult {
  const { isStreaming = false } = options;
  const prependOlder = useSetAtom(prependOlderMessagesAtom);
  const loadOlderInFlightRef = useRef(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  const [localHasMore, setLocalHasMore] = useState(false);
  const hasMoreRef = useRef(false);
  const [loadOlderError, setLoadOlderError] = useState<Error | null>(null);

  const prevSubChatIdRef = useRef(subChatId);

  // Reset local hasMore and loadOlderError when subChatId changes
  useEffect(() => {
    if (prevSubChatIdRef.current !== subChatId) {
      prevSubChatIdRef.current = subChatId;
      setLocalHasMore(false);
      hasMoreRef.current = false;
      setLoadOlderError(null);
    }
  }, [subChatId]);

  const {
    data,
    isLoading,
    isFetching,
    error: queryError,
    refetch,
  } = trpc.chats.getSubChatMessages.useQuery(
    { subChatId: subChatId ?? '', limit: INITIAL_PAGE_SIZE },
    { enabled: !!subChatId, refetchOnWindowFocus: false },
  );

  const messages = (data?.messages ?? EMPTY_MESSAGES) as UIMessage[];

  // Sync local hasMore from initial query data
  useEffect(() => {
    if (data) {
      perfMark('chat:messages-loaded', {
        subChatId,
        count: data.messages.length,
        hasMore: data.hasMore,
      });
      setLocalHasMore(data.hasMore);
      hasMoreRef.current = data.hasMore;
    }
  }, [data, subChatId]);

  const loadOlder = useCallback(async () => {
    if (!subChatId || isStreaming || loadOlderInFlightRef.current || !hasMoreRef.current) return;

    const allIds = appStore.get(perSubChatMessageIdsAtomFamily(subChatId));
    const firstId = allIds[0];
    if (!firstId) return;

    loadOlderInFlightRef.current = true;
    setIsLoadingOlder(true);
    setLoadOlderError(null);
    try {
      const result = await trpcClient.chats.getSubChatMessages.query({
        subChatId,
        limit: LOAD_OLDER_PAGE_SIZE,
        beforeMessageId: firstId,
      });

      // Update hasMore from server response so pagination converges
      setLocalHasMore(result.hasMore);
      hasMoreRef.current = result.hasMore;

      if (result.messages.length > 0) {
        prependOlder({ subChatId, messages: result.messages as UIMessage[] });
      }
    } catch (err) {
      setLoadOlderError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      loadOlderInFlightRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [subChatId, isStreaming, prependOlder]);

  const error = queryError ? (queryError as unknown as Error) : null;

  return useMemo(
    () => ({
      messages,
      isLoading,
      isFetching,
      isLoadingOlder,
      hasMore: localHasMore,
      loadOlder,
      error,
      loadOlderError,
      refetch,
    }),
    [
      messages,
      isLoading,
      isFetching,
      isLoadingOlder,
      localHasMore,
      loadOlder,
      error,
      loadOlderError,
      refetch,
    ],
  );
}

export { INITIAL_PAGE_SIZE };
