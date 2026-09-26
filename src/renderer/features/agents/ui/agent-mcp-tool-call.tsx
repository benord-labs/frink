import { ChevronRight } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { unwrapMcpOutput } from '../../../../shared/lib/mcp-output';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { cn } from '../../../lib/utils';
import type { MessagePart } from '../stores/message-store';
import { AgentToolInterrupted } from './agent-tool-interrupted';
import { getToolStatus, type McpToolInfo } from './agent-tool-registry';
import { areToolPropsEqual } from './agent-tool-utils';
import { ShikiCodeBlock } from './shiki-code-block';

export { unwrapMcpOutput } from '../../../../shared/lib/mcp-output';

type AgentMcpToolCallProps = {
  part: MessagePart;
  mcpInfo: McpToolInfo;
  chatStatus?: string;
  /** Inside another glass card (a subagent's): a tint, not a second glass. */
  nested?: boolean;
};

export function getResultCount(output: unknown): string | null {
  if (!output) return null;

  if (Array.isArray(output)) {
    const n = output.length;
    return `${n} ${n === 1 ? 'result' : 'results'}`;
  }

  if (typeof output === 'object') {
    let longest: unknown[] | undefined;
    for (const v of Object.values(output as Record<string, unknown>)) {
      if (Array.isArray(v) && (!longest || v.length > longest.length)) {
        longest = v;
      }
    }
    if (longest) {
      const n = longest.length;
      return `${n} ${n === 1 ? 'result' : 'results'}`;
    }
  }

  return null;
}

export function formatMcpArgs(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return '';

  return entries
    .slice(0, 2)
    .map(([key, value]) => {
      const val = typeof value === 'string' ? value : JSON.stringify(value);
      const display = val.length > 80 ? `${val.slice(0, 77)}...` : val;
      return `${key}: ${display}`;
    })
    .join('  ');
}

/** Format MCP output as pretty-printed JSON for display, safe against circular refs. */
export function formatOutputForDisplay(output: unknown): string {
  const unwrapped = unwrapMcpOutput(output);
  if (typeof unwrapped === 'string') return unwrapped;
  try {
    return JSON.stringify(unwrapped, null, 2);
  } catch {
    return '[unserialisable output]';
  }
}

/** Compact one-line preview of MCP output, truncated for inline display. */
export function formatOutputPreview(output: unknown, maxLen = 140): string {
  const unwrapped = unwrapMcpOutput(output);
  if (unwrapped === undefined || unwrapped === null) return '';

  let line: string;
  if (typeof unwrapped === 'string') {
    line = unwrapped.replace(/\s+/g, ' ').trim();
  } else {
    try {
      line = JSON.stringify(unwrapped);
    } catch {
      return '[unserialisable output]';
    }
  }

  if (!line) return '';
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

function HighlightedJson({ code }: { code: string }) {
  return (
    <ShikiCodeBlock
      code={code}
      lang="json"
      className="text-[10px] font-mono leading-relaxed whitespace-pre-wrap wrap-break-word"
    />
  );
}

export const AgentMcpToolCall = memo(function AgentMcpToolCall({
  part,
  mcpInfo,
  chatStatus,
  nested,
}: AgentMcpToolCallProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { isPending, isError, isInterrupted } = getToolStatus(part, chatStatus);

  const unwrappedOutput = useMemo(() => unwrapMcpOutput(part.output), [part.output]);

  const title = mcpInfo.displayName;

  const resultCount = useMemo(() => {
    if (isPending) return null;
    return getResultCount(unwrappedOutput);
  }, [isPending, unwrappedOutput]);

  const subtitle = useMemo(() => {
    if (part.state === 'input-streaming') return '';
    return formatMcpArgs(part.input);
  }, [part.input, part.state]);

  const displayOutput = useMemo(() => {
    if (!part.output) return null;
    return formatOutputForDisplay(part.output);
  }, [part.output]);

  const outputPreview = useMemo(() => {
    if (isPending || !part.output) return '';
    return formatOutputPreview(part.output);
  }, [isPending, part.output]);

  const hasExpandableContent =
    ((part.input && Object.keys(part.input).length > 0) || !!part.output) && !isPending;

  if (isInterrupted && !part.output) {
    return (
      <AgentToolInterrupted toolName={mcpInfo.displayName} subtitle={`via ${mcpInfo.serverName}`} />
    );
  }

  return (
    <div
      className={cn(
        'my-1 rounded-md border overflow-hidden',
        nested ? 'bg-muted/30' : 'glass-card',
        isError ? 'border-destructive/40' : 'border-border',
      )}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke full-width expandable toggle row (custom layout), not a styled Button */}
      <button
        type="button"
        onClick={() => hasExpandableContent && setIsExpanded(!isExpanded)}
        disabled={!hasExpandableContent}
        aria-expanded={hasExpandableContent ? isExpanded : undefined}
        className={cn(
          'group flex w-full items-start gap-1.5 py-1 px-2.5 text-left',
          'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
          hasExpandableContent ? 'cursor-pointer hover:bg-muted/60' : 'cursor-default',
        )}
      >
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div
            className={cn(
              'text-xs flex items-center gap-1.5 min-w-0',
              isError ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            <span className="font-medium whitespace-nowrap shrink-0">
              {isPending ? (
                <TextShimmer
                  as="span"
                  duration={1.2}
                  className="inline-flex items-center text-xs leading-none h-4 m-0"
                >
                  {title}
                </TextShimmer>
              ) : (
                title
              )}
            </span>

            {subtitle && (
              <span
                title={subtitle}
                className="text-muted-foreground/70 font-normal truncate min-w-0"
              >
                {subtitle}
              </span>
            )}

            {resultCount && (
              <span className="text-muted-foreground/70 font-normal whitespace-nowrap shrink-0">
                {resultCount}
              </span>
            )}

            {isError && (
              <span className="text-destructive font-normal whitespace-nowrap shrink-0">error</span>
            )}

            {hasExpandableContent && (
              <ChevronRight
                className={cn(
                  'w-3.5 h-3.5 text-muted-foreground/70 transition-transform duration-200 ease-out shrink-0',
                  isExpanded && 'rotate-90',
                  !isExpanded &&
                    'opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
              />
            )}
          </div>
        </div>
      </button>

      {!isExpanded && outputPreview && (
        <div
          title={outputPreview}
          className="px-2.5 pb-1 text-[11px] text-muted-foreground/70 font-mono truncate border-t border-border/60 pt-1"
        >
          {outputPreview}
        </div>
      )}

      {isExpanded && hasExpandableContent && (
        <div className="border-t border-border/60">
          {part.input && Object.keys(part.input).length > 0 && (
            <div className="px-2.5 py-1.5 space-y-0.5">
              {Object.entries(part.input)
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .map(([key, value]) => (
                  <div key={key} className="flex items-baseline gap-1.5 text-[10px]">
                    <span className="text-muted-foreground/70 font-mono shrink-0">{key}:</span>
                    <span className="text-muted-foreground font-mono truncate">
                      {typeof value === 'string'
                        ? value.length > 120
                          ? `${value.slice(0, 117)}...`
                          : value
                        : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {displayOutput && (
            <div
              className={cn(
                'px-2.5 py-1.5 max-h-[200px] overflow-y-auto',
                part.input && Object.keys(part.input).length > 0 && 'border-t border-border/60',
              )}
            >
              <HighlightedJson code={displayOutput} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}, areToolPropsEqual);
