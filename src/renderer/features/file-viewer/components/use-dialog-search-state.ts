import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchDebounce } from '../../files-sidebar/use-search-debounce';

type UseDialogSearchStateOptions = {
  open: boolean;
};

export function useDialogSearchState({ open }: UseDialogSearchStateOptions) {
  const { searchQuery, debouncedQuery, setSearchQuery } = useSearchDebounce();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    setSearchQuery('');
    setSelectedIndex(0);
    itemRefs.current = [];
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, setSearchQuery]);

  useEffect(() => {
    const selected = itemRefs.current[selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
      setSelectedIndex(0);
      itemRefs.current = [];
    },
    [setSearchQuery],
  );

  const setItemRef = useCallback((index: number, el: HTMLElement | null) => {
    itemRefs.current[index] = el;
  }, []);

  return {
    query: searchQuery,
    debouncedQuery,
    selectedIndex,
    setSelectedIndex,
    inputRef,
    handleQueryChange,
    setItemRef,
  };
}
