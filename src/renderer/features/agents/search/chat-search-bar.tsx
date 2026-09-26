/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import type { UIMessage } from 'ai';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '../../../lib/utils';
import { useIsPaneActive } from '../hooks/use-is-pane-active';
import type { Message } from '../stores/message-store';
import {
  chatSearchCountInfoAtom,
  chatSearchCurrentIndexAtom,
  chatSearchInputAtom,
  chatSearchMatchesAtom,
  chatSearchOpenAtom,
  chatSearchQueryAtom,
  closeSearchAtom,
  goToNextMatchAtom,
  goToPrevMatchAtom,
} from './chat-search-atoms';
import { extractSearchableText, findMatches } from './chat-search-utils';

type ChatSearchBarProps = {
  messages: Message[] | UIMessage[];
  className?: string;
  topOffset?: string; // e.g., "52px" when sub-chat selector is open
  splitPaneIndex?: number; // Which pane this search bar lives in (undefined = single view)
};

/** Shared icon-nav button for the prev/next/close controls (ghost, 6×6, icon-only). */
function SearchNavButton({
  onClick,
  title,
  className,
  children,
}: {
  onClick: () => void;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('h-6 w-6 active:scale-95 transition-all duration-150 ease-out', className)}
      onClick={onClick}
      title={title}
      aria-label={title}
      iconOnly
    >
      {children}
    </Button>
  );
}

/**
 * Gate component: reactively reads splitViewAtom.activePaneIndex to determine
 * if this pane is active. Skips mounting the inner search bar (and all its atom
 * subscriptions / effects) when it isn't.
 */
export function ChatSearchBar({ splitPaneIndex, ...props }: ChatSearchBarProps) {
  const isOpen = useAtomValue(chatSearchOpenAtom);
  const isActivePane = useIsPaneActive(splitPaneIndex);
  if (!isOpen || !isActivePane) return null;
  return <ChatSearchBarInner {...props} />;
}

function ChatSearchBarInner({
  messages,
  className,
  topOffset,
}: Omit<ChatSearchBarProps, 'splitPaneIndex'>) {
  const [inputValue, setInputValue] = useAtom(chatSearchInputAtom);
  const setSearchQuery = useSetAtom(chatSearchQueryAtom);
  const setMatches = useSetAtom(chatSearchMatchesAtom);
  const setCurrentIndex = useSetAtom(chatSearchCurrentIndexAtom);
  const countInfo = useAtomValue(chatSearchCountInfoAtom);
  const closeSearch = useSetAtom(closeSearchAtom);
  const goToNext = useSetAtom(goToNextMatchAtom);
  const goToPrev = useSetAtom(goToPrevMatchAtom);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track if search has completed (to avoid showing "No results" while typing)
  const [searchCompleted, setSearchCompleted] = useState(false);

  // On mount (pane switch), immediately recompute matches for this pane's messages
  // to avoid a 200ms stale-highlight window from the debounced search effect
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only — debounced effect handles subsequent changes
  useEffect(() => {
    if (inputValue.trim()) {
      const extracted = extractSearchableText(messages);
      const newMatches = findMatches(extracted, inputValue);
      setMatches(newMatches);
      setCurrentIndex(0);
    } else {
      setMatches([]);
      setCurrentIndex(0);
    }
    // Only run on mount — the debounced effect handles subsequent input changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus input when search opens
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  // Handle select all event (when Cmd+F is pressed while search is already open)
  useEffect(() => {
    const handleSelectAll = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };

    window.addEventListener('chat-search-select-all', handleSelectAll);
    return () => window.removeEventListener('chat-search-select-all', handleSelectAll);
  }, []);

  // Debounced search
  useEffect(() => {
    // Mark search as not completed when input changes
    setSearchCompleted(false);

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    debounceTimeoutRef.current = setTimeout(() => {
      setSearchQuery(inputValue);

      if (!inputValue.trim()) {
        setMatches([]);
        setCurrentIndex(0);
        setSearchCompleted(true);
        return;
      }

      // Extract and search
      const extracted = extractSearchableText(messages);
      const matches = findMatches(extracted, inputValue);

      setMatches(matches);
      setCurrentIndex(0);
      setSearchCompleted(true);
    }, 200);

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [inputValue, messages, setSearchQuery, setMatches, setCurrentIndex]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          goToPrev();
        } else {
          goToNext();
        }
      } else if (
        e.key === 'ArrowDown' ||
        (e.key === 'g' && !e.shiftKey && (e.metaKey || e.ctrlKey))
      ) {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'ArrowUp' || (e.key === 'g' && e.shiftKey && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        goToPrev();
      }
    },
    [closeSearch, goToNext, goToPrev],
  );

  // Focus input when clicking on container (but not on buttons)
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    // Only focus if clicking directly on container or non-interactive elements
    const target = e.target as HTMLElement;
    if (!target.closest('button')) {
      inputRef.current?.focus();
    }
  }, []);

  return (
    <div
      className={cn(
        'absolute right-3 left-3 z-50',
        'flex items-center gap-1 px-2 py-1.5',
        'border rounded-lg shadow-lg',
        overlayGlass,
        'animate-in fade-in-0 slide-in-from-top-2 duration-150',
        'max-w-[340px] ml-auto cursor-text', // Max width, but can shrink; ml-auto pushes to right
        className,
      )}
      style={{ top: topOffset ? topOffset : '0px' }}
    >
      {/* Search input - grows to fill space, shrinks on narrow screens */}
      <input
        ref={inputRef}
        type="search"
        aria-label="Search chat"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onClick={handleContainerClick}
        placeholder="Search..."
        className={cn(
          'flex-1 min-w-[80px] h-7 px-2 text-sm bg-transparent',
          'border-none outline-hidden',
          'placeholder:text-muted-foreground/60',
        )}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      {/* Results area - fixed width: shows counter+arrows OR "No results" */}
      <div className="w-[128px] flex items-center justify-end shrink-0">
        {countInfo.total > 0 ? (
          <>
            <span className="text-xs text-muted-foreground mr-1">
              {`${countInfo.current} of ${countInfo.total}`}
            </span>
            <SearchNavButton
              onClick={() => {
                goToPrev();
                inputRef.current?.focus();
              }}
              title="Previous match (Shift+Enter)"
            >
              <ChevronUp className="h-4 w-4" />
            </SearchNavButton>
            <SearchNavButton
              onClick={() => {
                goToNext();
                inputRef.current?.focus();
              }}
              title="Next match (Enter)"
            >
              <ChevronDown className="h-4 w-4" />
            </SearchNavButton>
          </>
        ) : (
          inputValue.trim() &&
          searchCompleted && <span className="text-xs text-muted-foreground">No results</span>
        )}
      </div>

      {/* Close button - fixed width */}
      <SearchNavButton onClick={() => closeSearch()} title="Close (Esc)" className="shrink-0">
        <X className="h-4 w-4" />
      </SearchNavButton>
    </div>
  );
}
