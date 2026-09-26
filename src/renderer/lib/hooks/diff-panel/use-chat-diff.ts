import { useCallback, useMemo } from 'react';
import { trpc } from '../../trpc';
import { getDiffReadError } from '../../utils/diff/diff-code-view-items';

/** The chat's uncommitted diff from the query cache: every reader shares one request per chat,
 * and `refresh` is how triggers (agent edits, git watcher, focus) ask for newer data. */
export function useChatDiff(chatId: string, enabled: boolean) {
  const utils = trpc.useUtils();
  const query = trpc.chats.getParsedDiff.useQuery({ chatId }, { enabled: enabled && !!chatId });
  const { data } = query;

  const error = getDiffReadError(data, query.error);

  const files = data?.files ?? null;
  const diffStats = useMemo(
    () => ({
      fileCount: files?.length ?? 0,
      additions: data?.totalAdditions ?? 0,
      deletions: data?.totalDeletions ?? 0,
      isLoading: query.isLoading,
      hasChanges: (files?.length ?? 0) > 0,
    }),
    [files, data, query.isLoading],
  );

  const refresh = useCallback(
    () => utils.chats.getParsedDiff.invalidate({ chatId }),
    [utils, chatId],
  );

  return { files, diffStats, error, refresh };
}
