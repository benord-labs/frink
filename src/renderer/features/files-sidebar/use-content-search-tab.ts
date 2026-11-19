import { useAtom } from 'jotai';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { isInvalidContentSearchRegex } from '../../../shared/utils/content-search-regex';
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
  /** The typed query differs from the one searched, until the debounce catches up */
  isContentSearchStale: boolean;
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

/**
 * One folder's matches for the Search tab's query. A new query or new options load with no
 * matches, so a section never shows an earlier query's lines under the new one; the same query
 * read again, after a save, keeps its matches up while it reloads. A pattern that isn't a valid
 * regular expression reads as invalid at once and isn't sent.
 */
export function useContentSearch({
  projectPath,
  query,
  options,
  enabled,
  staleTime,
}: UseContentSearchParams) {
  const trimmedQuery = query.trim();
  const invalidPattern =
    options.useRegex &&
    trimmedQuery.length > 0 &&
    isInvalidContentSearchRegex(trimmedQuery, options.wholeWord);
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
      enabled: enabled && trimmedQuery.length > 0 && !invalidPattern,
      ...(typeof staleTime === 'number' ? { staleTime } : {}),
    },
  );
  return {
    matches: Array.isArray(data?.matches) ? (data.matches as ContentSearchMatch[]) : [],
    invalidRegex: invalidPattern || data?.invalidRegex === true,
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
    isContentSearchStale: contentSearchQuery.trim() !== contentDebouncedQuery.trim(),
    highlightContentMatch,
  };
}
