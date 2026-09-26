/**
 * Hook to manage expansion state of tree nodes
 * Persists to localStorage for this machine's single local user
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'frink-sidebar-expansion';

export function useExpansionState() {
  const [codebases, setCodebases] = useState<Set<string>>(() => new Set());

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setCodebases(new Set(JSON.parse(stored).codebases ?? []));
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  // Persist to localStorage
  const persist = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ codebases: Array.from(next) }));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const toggleCodebase = useCallback(
    (gitRemote: string) => {
      setCodebases((prev) => {
        const next = new Set(prev);
        if (next.has(gitRemote)) {
          next.delete(gitRemote);
        } else {
          next.add(gitRemote);
        }
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const isCodebaseExpanded = useCallback(
    (gitRemote: string) => codebases.has(gitRemote),
    [codebases],
  );

  const collapseAll = useCallback(() => {
    const next = new Set<string>();
    persist(next);
    setCodebases(next);
  }, [persist]);

  return { isCodebaseExpanded, toggleCodebase, collapseAll };
}
