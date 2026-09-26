import { Button } from '@benord-labs/frink-primitives';
import { cn } from '@/lib/utils';
import type { ContentSearchOptions } from '../types/content-search-options';

type ContentSearchOptionsRowProps = {
  options: ContentSearchOptions;
  onChange: (next: ContentSearchOptions) => void;
};

function ToggleButton({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
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

export function ContentSearchOptionsRow({ options, onChange }: ContentSearchOptionsRowProps) {
  return (
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
    </div>
  );
}
