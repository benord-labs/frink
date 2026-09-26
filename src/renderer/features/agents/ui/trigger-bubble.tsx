/* eslint-disable max-lines-per-function */
/**
 * TriggerBubble - compact summary of what triggered a task, rendered from the shared
 * {@link TriggerSummary} model (same data the Work Queue card + dialog render).
 */

import { Button } from '@benord-labs/frink-primitives';
import { Check, ChevronDown, ChevronUp, Copy, Zap } from 'lucide-react';
import { memo, useState } from 'react';
import { TriggerContentDialog } from '@/features/work-queue/WorkQueue/ActionMenu/TriggerContentDialog';
import type { TriggerSummary } from '../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../shared/types/trigger-context';
import { BRAND_TILE_STYLE, ProviderIcon } from '../../../components/ProviderIcon';
import {
  TriggerSummaryChanges,
  TriggerSummaryFieldRow,
} from '../../../components/TriggerSummaryFields';
import { cn } from '../../../lib/utils';

type TriggerBubbleProps = {
  data: TriggerSummary;
  triggerContext?: TriggerContext | null;
  fullPrompt?: string;
  className?: string;
};

export const TriggerBubble = memo(function TriggerBubble({
  data,
  triggerContext,
  fullPrompt,
  className,
}: TriggerBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isDev = import.meta.env.DEV;
  const canOpenDialog = triggerContext != null;

  const onCopyPrompt = async () => {
    if (!fullPrompt) return;
    try {
      await navigator.clipboard.writeText(fullPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={cn('flex justify-start w-full', className)}>
      <div className="w-full rounded-lg border border-border glass-float transition-all duration-200">
        {/* Header */}
        <Button
          variant="ghost"
          size="auto"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          className="w-full justify-start text-left font-normal flex gap-2 rounded-none px-3 py-2.5 border-b border-border/60"
        >
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md"
            style={BRAND_TILE_STYLE}
          >
            <ProviderIcon providerId={data.source} appearance="tile" className="size-3.5" />
          </span>
          <span className="text-xs text-muted-foreground flex-1">{data.provider}</span>
          {data.autoStart && (
            <span role="img" aria-label="Auto-start enabled">
              <Zap className="h-3 w-3 text-yellow-500 shrink-0" aria-hidden />
            </span>
          )}
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
          )}
        </Button>

        {/* Collapsed: title + subtitle */}
        {!isExpanded && (
          <div className="px-3 pb-3 pt-2.5 space-y-1">
            {data.title && (
              <p className="text-sm text-foreground font-medium truncate">{data.title}</p>
            )}
            {data.subtitle && (
              <p className="text-xs text-muted-foreground truncate">{data.subtitle}</p>
            )}
          </div>
        )}

        {/* Expanded */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-3 space-y-0 divide-y divide-border/70">
            {(data.title || data.description) && (
              <div className="pb-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Overview
                </p>
                {data.title && (
                  <p className="text-lg text-foreground font-semibold leading-snug">{data.title}</p>
                )}
                {data.description && (
                  <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-2.5">
                    <div className="max-h-[140px] overflow-y-auto pr-1">
                      <p className="text-xs text-foreground/90 whitespace-pre-wrap">
                        {data.description}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {data.fields.length > 0 && (
              <div className="py-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Detected metadata
                </p>
                <div className="space-y-0 divide-y divide-border/60">
                  {data.fields.map((f) => (
                    <TriggerSummaryFieldRow
                      key={f.label}
                      label={f.label}
                      value={f.value}
                      tone={f.tone}
                      href={f.href}
                    />
                  ))}
                </div>
              </div>
            )}

            {data.changes && data.changes.length > 0 && (
              <div className="py-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  What changed
                </p>
                <TriggerSummaryChanges changes={data.changes} />
              </div>
            )}

            {isDev && fullPrompt && (
              <div className="py-4">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Prompt used
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[10px] gap-1 min-h-11 min-w-11 h-auto px-2 rounded-md border border-transparent hover:border-border"
                    onClick={onCopyPrompt}
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <pre className="text-xs text-foreground whitespace-pre-wrap max-h-[220px] overflow-y-auto bg-background/40 border border-border rounded-md p-2 font-mono">
                  {fullPrompt}
                </pre>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap pt-4">
              {canOpenDialog && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsDialogOpen(true)}
                  className="rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground hover:bg-secondary/70 h-auto"
                >
                  Open content
                </Button>
              )}
              {data.link && (
                <a
                  href={data.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-xs text-blue-400 hover:underline"
                >
                  Open in {data.provider}
                  <span className="sr-only"> (opens in new tab)</span>
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      {canOpenDialog && triggerContext && (
        <TriggerContentDialog
          open={isDialogOpen}
          onOpenChange={setIsDialogOpen}
          triggerContext={triggerContext}
        />
      )}
    </div>
  );
});
