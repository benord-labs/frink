/**
 * LoadTemplatePicker — a small icon button that opens a popover listing
 * saved templates. Only shown when the batch has zero stages (prevents
 * destructive overwrite of in-progress work, per EC12).
 *
 * Clicking a template copies its structural stages as JSON to the clipboard
 * so the user can reference them in a CEO agent conversation with the
 * frink_flows_list_catalog({ kind: "templates" }) MCP tool or paste directly.
 */

import { Button } from '@benord-labs/frink-primitives';
import { BookOpen, Check, ChevronRight, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../../components/ui/popover';
import { trpc } from '../../../../../../lib/trpc';

type Props = {
  flowId: string;
};

export function LoadTemplatePicker({ flowId }: Props) {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copiedClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCopiedTimer = useCallback(() => {
    if (copiedClearTimeoutRef.current != null) {
      clearTimeout(copiedClearTimeoutRef.current);
      copiedClearTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearCopiedTimer();
    };
  }, [clearCopiedTimer]);

  const {
    data: templates,
    isLoading,
    isError,
  } = trpc.flows.listBatchPlanTemplates.useQuery({ flowId }, { enabled: open, staleTime: 30_000 });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    clearCopiedTimer();
    if (next) {
      setCopyError(null);
      setCopiedId(null);
    }
  };

  const handleCopy = (id: string, stages: unknown) => {
    clearCopiedTimer();
    setCopyError(null);
    const text = JSON.stringify(stages, null, 2);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(id);
        copiedClearTimeoutRef.current = setTimeout(() => {
          copiedClearTimeoutRef.current = null;
          setCopiedId(null);
        }, 2000);
      })
      .catch(() => {
        setCopyError("Couldn't copy to clipboard");
      });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded text-muted-foreground"
          aria-label="Load template"
          title="Load template"
        >
          <BookOpen className="h-3 w-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="px-3 pt-3 pb-2 border-b border-border/30">
          <p className="text-xs font-medium text-foreground">Templates</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            Click to copy stage structure. Paste into a chat with the CEO agent to apply.
          </p>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            <span className="text-xs">Loading…</span>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center gap-2 py-6 text-destructive/70">
            <XCircle className="h-3.5 w-3.5" aria-hidden />
            <span className="text-xs">Failed to load templates</span>
          </div>
        )}

        {!isLoading && !isError && (templates == null || templates.length === 0) && (
          <p className="px-3 py-5 text-center text-xs text-muted-foreground">
            No templates saved yet. Use &quot;Save as template&quot; after running a staged batch.
          </p>
        )}

        {!isLoading && !isError && templates != null && templates.length > 0 && (
          <ul className="max-h-64 overflow-y-auto py-1">
            {templates.map((template) => {
              const isCopied = copiedId === template.id;
              return (
                <li key={template.id}>
                  <Button
                    variant="ghost"
                    size="auto"
                    onClick={() => handleCopy(template.id, template.stages)}
                    className="w-full justify-start text-left font-normal group flex justify-between gap-2 rounded-none px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">
                        {template.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {template.stages.length} stage{template.stages.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    {isCopied ? (
                      <Check className="h-3 w-3 text-green-500 shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight
                        className="h-3 w-3 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors"
                        aria-hidden
                      />
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {copyError && (
          <p
            className="px-3 py-2 text-[10px] text-destructive border-t border-border/30"
            role="alert"
          >
            {copyError}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
