import { ChevronRight, ExternalLink } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { cn } from '../../../lib/utils';
import type { MessagePart } from '../stores/message-store';
import { areToolPropsEqual } from './agent-tool-utils';

type SearchResult = {
  title: string;
  url: string;
};

type AgentWebSearchCollapsibleProps = {
  part: MessagePart;
  chatStatus?: string;
};

export const AgentWebSearchCollapsible = memo(function AgentWebSearchCollapsible({
  part,
  chatStatus,
}: AgentWebSearchCollapsibleProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isPending = part.state !== 'output-available' && part.state !== 'output-error';
  // Include "submitted" status — request sent but streaming hasn't started yet
  const isActivelyStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';
  const isStreaming = isPending && isActivelyStreaming;

  const query = typeof part.input?.query === 'string' ? part.input.query : '';

  const results = useMemo(() => {
    if (!part.output?.results || !Array.isArray(part.output.results)) return [];

    const rawResults = part.output.results;
    const allResults: SearchResult[] = [];

    for (const result of rawResults) {
      if (result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.title && item.url) {
            allResults.push({ title: item.title, url: item.url });
          }
        }
      } else if (result.title && result.url) {
        allResults.push({ title: result.title, url: result.url });
      }
    }

    return allResults;
  }, [part.output?.results]);

  const resultCount = results.length;
  const hasResults = resultCount > 0;
  const hasExpandableContent = hasResults && !isPending;
  const title = isStreaming ? 'Searching web' : 'Searched web';

  return (
    <div className="my-1 rounded-md border border-border glass-card overflow-hidden">
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
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap shrink-0">
              {isStreaming ? (
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

            {query && (
              <span title={query} className="text-muted-foreground/70 font-normal truncate min-w-0">
                {query}
              </span>
            )}

            {!isStreaming && hasResults && (
              <span className="text-muted-foreground/70 font-normal whitespace-nowrap shrink-0">
                {resultCount} {resultCount === 1 ? 'result' : 'results'}
              </span>
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

      {isExpanded && hasResults && (
        <div className="border-t border-border/60 px-2 py-1.5 space-y-1">
          {results.map((result) => (
            <a
              key={result.url}
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-1.5 px-2 py-1 rounded hover:bg-muted/60 transition-colors group/link"
            >
              <ExternalLink className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground group-hover/link:text-foreground transition-colors" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-foreground truncate">{result.title}</div>
                <div className="text-[10px] text-muted-foreground truncate">{result.url}</div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}, areToolPropsEqual);
