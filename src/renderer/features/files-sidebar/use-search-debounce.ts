import { useCallback, useEffect, useState } from 'react';
import { SEARCH_DEBOUNCE_MS } from './constants';

type ReturnValue = {
  searchQuery: string;
  debouncedQuery: string;
  setSearchQuery: (query: string) => void;
  clearSearch: () => void;
};

/**
 * Custom hook for debounced search query
 * Separates search input state from debounced query for performance
 */
export function useSearchDebounce(): ReturnValue {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  return {
    searchQuery,
    debouncedQuery,
    setSearchQuery,
    clearSearch,
  };
}
