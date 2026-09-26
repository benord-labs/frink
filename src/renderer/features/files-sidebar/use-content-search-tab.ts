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

  const trimmedContentQuery = contentDebouncedQuery.trim();
  const { data: rawContentMatches, isLoading: isLoadingContentSearch } =
    trpc.files.searchContent.useQuery(
      {
        projectPath,
        query: trimmedContentQuery,
        limit: CONTENT_SEARCH_LIMIT,
        matchCase: contentSearchOptions.matchCase,
        wholeWord: contentSearchOptions.wholeWord,
        useRegex: contentSearchOptions.useRegex,
      },
      {
        enabled: canSearch && isSearchTabActive && trimmedContentQuery.length > 0,
        placeholderData: (prev) => prev,
        ...(typeof staleTime === 'number' ? { staleTime } : {}),
      },
    );

  const contentMatches = Array.isArray(rawContentMatches?.matches)
    ? (rawContentMatches.matches as ContentSearchMatch[])
    : [];
  const contentSearchInvalidRegex = rawContentMatches?.invalidRegex === true;

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
