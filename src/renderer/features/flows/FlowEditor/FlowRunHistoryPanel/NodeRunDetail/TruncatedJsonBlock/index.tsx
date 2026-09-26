import { Button } from '@benord-labs/frink-primitives';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '../../../../../../lib/utils';

const OUTPUT_RENDER_CAP = 4096;

type TruncatedJsonBlockProps = {
  label: string;
  value: string;
  className?: string;
};

export function TruncatedJsonBlock({ label, value, className }: TruncatedJsonBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const truncated = value.length > OUTPUT_RENDER_CAP;
  const display = !truncated || expanded ? value : `${value.slice(0, OUTPUT_RENDER_CAP)}…`;

  const copyFull = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {truncated && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              aria-expanded={expanded}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px] gap-0.5"
            onClick={copyFull}
          >
            <Copy className="h-2.5 w-2.5" aria-hidden />
            Copy
          </Button>
        </div>
      </div>
      {truncated && !expanded && (
        <p className="text-[10px] text-muted-foreground/60">
          Truncated for display — full output is {(value.length / 1024).toFixed(1)} KB. Use Copy for
          the full JSON.
        </p>
      )}
      <pre
        className={cn(
          'rounded border border-border/50 bg-muted/30 px-2 py-1.5 text-[10px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto',
        )}
      >
        {display}
      </pre>
    </div>
  );
}
