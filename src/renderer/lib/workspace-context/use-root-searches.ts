/**
 * Searches the files of several folders at once, for the pickers that search a chat's tree.
 */
import { useEffect, useRef } from 'react';
import { trpc, type trpcClient } from '@/lib/trpc';

type SearchEntry = Awaited<ReturnType<typeof trpcClient.files.search.query>>[number];

/**
 * Searches each folder. useQueries starts a new observer for every new query, so `placeholderData`
 * has no previous result of its own: each folder's last results come from a ref instead, and stay
 * on screen while its next search loads. `isFetching` is true while any folder's search runs, and
 * `isLoading` while any folder has no results yet to show.
 */
export function useRootSearches(
  roots: ReadonlyArray<{ path: string }>,
  query: string,
  enabled: boolean,
) {
  const lastResults = useRef(new Map<string, SearchEntry[]>());
  const searches = trpc.useQueries((t) =>
    roots.map((root) =>
      t.files.search(
        { projectPath: root.path, query, limit: 50 },
        { enabled, placeholderData: () => lastResults.current.get(root.path) },
      ),
    ),
  );
  useEffect(() => {
    searches.forEach(({ data, isPlaceholderData }, i) => {
      const root = roots[i];
      if (root && data && !isPlaceholderData) lastResults.current.set(root.path, data);
    });
  });
  return {
    results: searches.map((search) => search.data),
    isFetching: searches.some((search) => search.isFetching),
    isLoading: searches.some((search) => search.isLoading),
  };
}
