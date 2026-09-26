import { useAtomValue } from 'jotai';
import type * as React from 'react';
import { createContext, useCallback, useContext, useMemo } from 'react';

import { useIsPaneActive } from '../hooks/use-is-pane-active';
import {
  chatSearchCurrentMatchAtom,
  chatSearchMatchesAtom,
  chatSearchOpenAtom,
  chatSearchQueryAtom,
  type HighlightRange,
  type SearchMatch,
} from './chat-search-atoms';

// ============================================================================
// CONTEXT TYPES
// ============================================================================

type SearchHighlightContextValue = {
  query: string;
  isSearchActive: boolean;
  getHighlightRanges: (messageId: string, partIndex: number, partType: string) => HighlightRange[];
};

const SearchHighlightContext = createContext<SearchHighlightContextValue | null>(null);

// ============================================================================
// PROVIDER
// ============================================================================

type SearchHighlightProviderProps = {
  children: React.ReactNode;
  splitPaneIndex?: number;
};

// Empty context value when search is closed - stable reference to avoid re-renders
const EMPTY_HIGHLIGHT_RANGES: HighlightRange[] = [];
const emptyGetHighlightRanges = () => EMPTY_HIGHLIGHT_RANGES;
const CLOSED_SEARCH_VALUE: SearchHighlightContextValue = {
  query: '',
  isSearchActive: false,
  getHighlightRanges: emptyGetHighlightRanges,
};

export function SearchHighlightProvider({
  children,
  splitPaneIndex,
}: SearchHighlightProviderProps) {
  const isOpen = useAtomValue(chatSearchOpenAtom);
  const isActivePane = useIsPaneActive(splitPaneIndex);

  // When search is closed or this isn't the active pane, render with static empty context
  // This prevents any subscriptions to query/matches/currentMatch in inactive panes
  if (!isOpen || !isActivePane) {
    return (
      <SearchHighlightContext.Provider value={CLOSED_SEARCH_VALUE}>
        {children}
      </SearchHighlightContext.Provider>
    );
  }

  // Search is open in the active pane - render the active provider
  return <SearchHighlightProviderActive>{children}</SearchHighlightProviderActive>;
}

// Separate component for when search is active
// This isolates the subscriptions to query/matches/currentMatch
function SearchHighlightProviderActive({ children }: SearchHighlightProviderProps) {
  const query = useAtomValue(chatSearchQueryAtom);
  const matches = useAtomValue(chatSearchMatchesAtom);
  const currentMatch = useAtomValue(chatSearchCurrentMatchAtom);

  // Build lookup map for efficient highlight retrieval
  const matchesByKey = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const key = `${match.messageId}:${match.partIndex}:${match.partType}`;
      const existing = map.get(key) || [];
      existing.push(match);
      map.set(key, existing);
    }
    return map;
  }, [matches]);

  const getHighlightRanges = useCallback(
    (messageId: string, partIndex: number, partType: string): HighlightRange[] => {
      const key = `${messageId}:${partIndex}:${partType}`;
      const relevantMatches = matchesByKey.get(key);

      if (!relevantMatches || relevantMatches.length === 0) {
        return EMPTY_HIGHLIGHT_RANGES;
      }

      return relevantMatches.map((m, idx) => ({
        offset: m.offset,
        length: m.length,
        isCurrent: currentMatch?.id === m.id,
        indexInPart: idx,
      }));
    },
    [matchesByKey, currentMatch],
  );

  const value = useMemo(
    () => ({
      query,
      isSearchActive: query.trim().length > 0,
      getHighlightRanges,
    }),
    [query, getHighlightRanges],
  );

  return (
    <SearchHighlightContext.Provider value={value}>{children}</SearchHighlightContext.Provider>
  );
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to get highlight ranges for a specific message part
 * Returns empty array if search is not active or no matches
 */
export function useSearchHighlight(
  messageId: string,
  partIndex: number,
  partType: string,
): HighlightRange[] {
  const context = useContext(SearchHighlightContext);

  if (!context?.isSearchActive) {
    return [];
  }

  return context.getHighlightRanges(messageId, partIndex, partType);
}

/**
 * Hook to get the current search query
 */
export function useSearchQuery(): string {
  const context = useContext(SearchHighlightContext);
  return context?.query ?? '';
}
