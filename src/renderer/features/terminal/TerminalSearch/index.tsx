import { Button } from '@benord-labs/frink-primitives';
import type { SearchAddon } from '@xterm/addon-search';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { overlayGlass } from '@/lib/overlay-styles';

type TerminalSearchProps = {
  searchAddon: SearchAddon | null;
  isOpen: boolean;
  onClose: () => void;
};

export function TerminalSearch({ searchAddon, isOpen, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  // Handle search
  const handleSearch = useCallback(
    (direction: 'next' | 'prev') => {
      if (!searchAddon || !query) return;

      if (direction === 'next') {
        searchAddon.findNext(query, { caseSensitive: false, regex: false });
      } else {
        searchAddon.findPrevious(query, { caseSensitive: false, regex: false });
      }
    },
    [searchAddon, query],
  );

  // Search on query change
  useEffect(() => {
    if (!searchAddon || !query) {
      setMatchCount(null);
      return;
    }

    // Trigger search
    searchAddon.findNext(query, { caseSensitive: false, regex: false });
  }, [searchAddon, query]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          handleSearch('prev');
        } else {
          handleSearch('next');
        }
      }
    },
    [onClose, handleSearch],
  );

  // Clear search when closed
  useEffect(() => {
    if (!isOpen && searchAddon) {
      searchAddon.clearDecorations();
    }
  }, [isOpen, searchAddon]);

  if (!isOpen) return null;

  return (
    <div
      className={`absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border p-1.5 shadow-lg ${overlayGlass}`}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        className="w-40 bg-transparent px-2 py-1 text-sm outline-hidden placeholder:text-muted-foreground"
      />
      {matchCount !== null && (
        <span className="px-1 text-xs text-muted-foreground">{matchCount} matches</span>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handleSearch('prev')}
        className="size-auto rounded p-1"
        title="Previous match (Shift+Enter)"
        iconOnly
      >
        <ChevronUp className="h-4 w-4 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handleSearch('next')}
        className="size-auto rounded p-1"
        title="Next match (Enter)"
        iconOnly
      >
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="size-auto rounded p-1"
        title="Close (Escape)"
        iconOnly
      >
        <X className="h-4 w-4 text-muted-foreground" />
      </Button>
    </div>
  );
}
