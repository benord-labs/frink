import { useAtom } from 'jotai';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { contentSearchOptionsAtom } from './atoms';
import type { ContentSearchMatch } from './types/content-search-match';
import type { ContentSearchOptions } from './types/content-search-options';
import { useSearchDebounce } from './use-search-debounce';
import { createMatchHighlighter } from './utils/highlight-match';

type UseContentSearchTabParams = {
  projectPath: string;
  canSearch: boolean;
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
  isLoadingContentSearch: boolean;
  highlightContentMatch: (text: string) => string | ReactNode[];
};

const CONTENT_SEARCH_LIMIT = 200;

type UseContentSearchParams = {
  projectPath: string;
  /** Searched once trimmed; an empty or blank query sends nothing */
  query: string;
  options: ContentSearchOptions;
  enabled: boolean;
  staleTime?: number;
};

/** One folder's matches for the Search tab's query. Earlier matches stay up while new ones load. */
export function useContentSearch({
  projectPath,
  query,
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
    isLoading,
  };
}

export function useContentSearchTab({
  projectPath,
  canSearch,
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
    isLoading: isLoadingContentSearch,
  } = useContentSearch({
    projectPath,
    query: contentDebouncedQuery,
    options: contentSearchOptions,
    enabled: canSearch && isSearchTabActive,
    staleTime,
  });

  const highlightContentMatch = useMemo(
    () => createMatchHighlighter(contentDebouncedQuery, contentSearchOptions),
    [contentDebouncedQuery, contentSearchOptions],
  );

  return {
    contentSearchQuery,
    contentDebouncedQuery,
    setContentSearchQuery,
    contentSearchOptions,
    setContentSearchOptions,
    contentMatches,
    contentSearchInvalidRegex,
    isLoadingContentSearch,
    highlightContentMatch,
  };
}
