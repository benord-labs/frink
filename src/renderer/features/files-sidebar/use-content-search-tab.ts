import { useAtom } from 'jotai';
import { trpc } from '@/lib/trpc';
import { contentSearchOptionsAtom } from './atoms';
import type { ContentSearchMatch } from './types/content-search-match';
import type { ContentSearchOptions } from './types/content-search-options';
import { useSearchDebounce } from './use-search-debounce';

type UseContentSearchTabParams = {
  projectPath: string;
  /** The split pane this search box sits in; the sidebar's box has none. */
  paneIndex?: number;
  /** Defaults to having a folder to search. */
  canSearch?: boolean;
  isSearchTabActive: boolean;
  staleTime?: number;
};

type UseContentSearchTabResult = {
  contentSearchQuery: string;
  contentDebouncedQuery: string;
  setContentSearchQuery: (value: string) => void;
  contentSearchOptions: ContentSearchOptions;
  setContentSearchOptions: (value: ContentSearchOptions) => void;
  contentMatches: ContentSearchMatch[];
  contentSearchInvalidRegex: boolean;
  contentSearchTimedOut: boolean;
  isLoadingContentSearch: boolean;
};

const CONTENT_SEARCH_LIMIT = 200;

/** One search box's key: the sidebar's, or a split pane's. Main adds the window and folder. */
function searchKeyFor(paneIndex: number | undefined): string {
  return paneIndex === undefined ? 'sidebar' : `pane:${paneIndex}`;
}

type UseContentSearchParams = {
  projectPath: string;
  /** Searched once trimmed; an empty or blank query sends nothing */
  query: string;
  /** The split pane whose search box this is, or none for the sidebar's. Main stops a box's
   * previous search when it starts a new one, and a box opened again keeps its key. */
  paneIndex?: number;
  options: ContentSearchOptions;
  enabled: boolean;
  staleTime?: number;
};

/** One folder's matches for the Search tab's query. Earlier matches stay up while new ones load. */
export function useContentSearch({
  projectPath,
  query,
  paneIndex,
  options,
  enabled,
  staleTime,
}: UseContentSearchParams) {
  const trimmedQuery = query.trim();
  const { data, isLoading } = trpc.files.searchContent.useQuery(
    {
      projectPath,
      query: trimmedQuery,
      limit: CONTENT_SEARCH_LIMIT,
      matchCase: options.matchCase,
      wholeWord: options.wholeWord,
      useRegex: options.useRegex,
      includeGlobs: options.includeGlobs ?? '',
      excludeGlobs: options.excludeGlobs ?? '',
      searchKey: searchKeyFor(paneIndex),
    },
    {
      enabled: enabled && trimmedQuery.length > 0,
      placeholderData: (prev) => prev,
      ...(typeof staleTime === 'number' ? { staleTime } : {}),
    },
  );
  return {
    matches: Array.isArray(data?.matches) ? (data.matches as ContentSearchMatch[]) : [],
    invalidRegex: data?.invalidRegex === true,
    timedOut: data?.timedOut === true,
    isLoading,
  };
}

export function useContentSearchTab({
  projectPath,
  paneIndex,
  canSearch = projectPath !== '',
  isSearchTabActive,
  staleTime,
}: UseContentSearchTabParams): UseContentSearchTabResult {
  const {
    searchQuery: contentSearchQuery,
    debouncedQuery: contentDebouncedQuery,
    setSearchQuery: setContentSearchQuery,
  } = useSearchDebounce();
  const [contentSearchOptions, setContentSearchOptions] = useAtom(contentSearchOptionsAtom);

  const {
    matches: contentMatches,
    invalidRegex: contentSearchInvalidRegex,
    timedOut: contentSearchTimedOut,
    isLoading: isLoadingContentSearch,
  } = useContentSearch({
    projectPath,
    query: contentDebouncedQuery,
    paneIndex,
    options: contentSearchOptions,
    enabled: canSearch && isSearchTabActive,
    staleTime,
  });

  return {
    contentSearchQuery,
    contentDebouncedQuery,
    setContentSearchQuery,
    contentSearchOptions,
    setContentSearchOptions,
    contentMatches,
    contentSearchInvalidRegex,
    contentSearchTimedOut,
    isLoadingContentSearch,
  };
}
