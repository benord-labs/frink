import { trpc } from '@/lib/trpc';

/** While a linked folder's drive isn't answering, the disk is asked again this often. */
const UNANSWERED_RECHECK_MS = 2_000;

export const cantOpenFolder = (name: string) =>
  `Can't open ${name}'s folder. It may have moved or been deleted.`;

/** Why a linked folder whose listing or search came back empty (`enabled`) shows nothing, if the
 * disk says it isn't simply empty. A drive that stopped answering is asked again until it does. */
export function useLinkedFolderAnswer(
  folderEntry: { projectPath: string; relativePath: string },
  name: string,
  enabled: boolean,
) {
  const folderType = trpc.files.entryType.useQuery(folderEntry, {
    enabled,
    refetchInterval: (query) =>
      query.state.data === 'unavailable' ? UNANSWERED_RECHECK_MS : false,
  });
  const answer = enabled && folderType.isSuccess ? folderType.data : 'folder';
  const problem =
    answer === 'unavailable'
      ? `${name}'s folder isn't answering. Its drive may be disconnected or asleep.`
      : answer === 'folder'
        ? null
        : cantOpenFolder(name);
  return { problem, isLoading: enabled && folderType.isLoading };
}
