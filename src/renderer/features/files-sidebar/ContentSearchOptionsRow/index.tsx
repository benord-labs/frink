import { Button, Input } from '@benord-labs/frink-primitives';
import { ListFilter } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ContentSearchOptions } from '../types/content-search-options';

type ContentSearchOptionsRowProps = {
  options: ContentSearchOptions;
  onChange: (next: ContentSearchOptions) => void;
};

const GLOB_COMMIT_DELAY_MS = 300;
// files.searchContent refuses a longer glob list.
const MAX_GLOB_LENGTH = 2000;

function ToggleButton({
  label,
  active,
  onClick,
  title,
}: {
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'h-auto border px-2 py-1 text-[11px]',
        active
          ? 'border-primary/40 bg-primary/15 text-foreground hover:bg-primary/15'
          : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
      )}
    >
      {label}
    </Button>
  );
}

/** A glob list typed freely and searched once typing pauses, or on Enter or leaving the box. */
function GlobInput({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Typing the user has not committed yet is kept when another pane saves its own globs.
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  const commit = useEffectEvent((next: string) => {
    dirty.current = false;
    if (next !== value) onCommit(next);
  });
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => commit(draft), GLOB_COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  // Closing the filters (or the sidebar) while typing still saves what was typed.
  const flush = useEffectEvent(() => {
    if (dirty.current) commit(draft);
  });
  useEffect(() => () => flush(), []);
  const commitNow = () => {
    if (!dirty.current) return;
    dirty.current = false;
    if (draft !== value) onCommit(draft);
  };

  return (
    <Input
      aria-label={label}
      title={label}
      placeholder={placeholder}
      value={draft}
      maxLength={MAX_GLOB_LENGTH}
      spellCheck={false}
      onChange={(event) => {
        dirty.current = true;
        setDraft(event.target.value);
      }}
      onBlur={commitNow}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commitNow();
      }}
      className="h-7 text-xs"
    />
  );
}

/** The saved glob lists, empty for options saved before globs existed. */
function savedGlobs({ includeGlobs = '', excludeGlobs = '' }: ContentSearchOptions) {
  return { includeGlobs, excludeGlobs, hasGlobs: `${includeGlobs}${excludeGlobs}`.trim() !== '' };
}

export function ContentSearchOptionsRow({ options, onChange }: ContentSearchOptionsRowProps) {
  const { includeGlobs, excludeGlobs, hasGlobs } = savedGlobs(options);
  const [showFilters, setShowFilters] = useState(hasGlobs);

  return (
    <>
      <div className="flex items-center gap-1">
        <ToggleButton
          label="Aa"
          title="Match case"
          active={options.matchCase}
          onClick={() => onChange({ ...options, matchCase: !options.matchCase })}
        />
        <ToggleButton
          label=".ab"
          title="Match whole word"
          active={options.wholeWord}
          onClick={() => onChange({ ...options, wholeWord: !options.wholeWord })}
        />
        <ToggleButton
          label=".*"
          title="Use regular expression"
          active={options.useRegex}
          onClick={() => onChange({ ...options, useRegex: !options.useRegex })}
        />
        <ToggleButton
          label={<ListFilter className="size-3" aria-hidden />}
          title="Filter files"
          active={showFilters || hasGlobs}
          onClick={() => setShowFilters((shown) => !shown)}
        />
      </div>
      {showFilters && (
        <div className="flex basis-full flex-col gap-1">
          <GlobInput
            label="Files to include"
            placeholder="Files to include, e.g. src, *.ts"
            value={includeGlobs}
            onCommit={(next) => onChange({ ...options, includeGlobs: next })}
          />
          <GlobInput
            label="Files to exclude"
            placeholder="Files to exclude, e.g. **/*.test.ts"
            value={excludeGlobs}
            onCommit={(next) => onChange({ ...options, excludeGlobs: next })}
          />
        </div>
      )}
    </>
  );
}
