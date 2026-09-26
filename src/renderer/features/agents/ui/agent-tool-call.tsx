import DOMPurify from 'isomorphic-dompurify';
import { memo } from 'react';
import { TextShimmer, type TextShimmerVariant } from '../../../components/ui/text-shimmer';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';

/** Sanitize tool subtitle for safe innerHTML (allows span+style for formatDiffSubtitle). */
function sanitizeSubtitle(html: string): string {
  return DOMPurify.sanitize(html, {
    // biome-ignore lint/style/useNamingConvention: DOMPurify API property name
    ALLOWED_TAGS: ['span'],
    // biome-ignore lint/style/useNamingConvention: DOMPurify API property name
    ALLOWED_ATTR: ['style'],
  });
}

type AgentToolCallProps = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  tooltipContent?: string;
  isPending: boolean;
  isError: boolean;
  isNested?: boolean;
  /** When true, title and subtitle wrap instead of truncating (e.g. inside task card expanded view) */
  allowWrap?: boolean;
  titleShimmerVariant?: TextShimmerVariant;
};

export const AgentToolCall = memo(
  function AgentToolCall({
    icon: _Icon,
    title,
    subtitle,
    tooltipContent,
    isPending,
    isError: _isError,
    isNested,
    allowWrap = false,
    titleShimmerVariant = 'default',
  }: AgentToolCallProps) {
    // Ensure title and subtitle are strings (copied from canvas)
    const titleStr = String(title);
    const subtitleStr = subtitle ? String(subtitle) : undefined;

    const subtitleClassName = allowWrap
      ? 'text-muted-foreground/60 font-normal wrap-break-word min-w-0'
      : 'text-muted-foreground/60 font-normal truncate min-w-0';

    // Render subtitle with optional tooltip (sanitized to prevent XSS from tool metadata)
    const sanitizedSubtitle = subtitleStr ? sanitizeSubtitle(subtitleStr) : undefined;
    const subtitleElement = sanitizedSubtitle ? (
      tooltipContent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={subtitleClassName}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify (ALLOWED_TAGS: span, ALLOWED_ATTR: style)
              dangerouslySetInnerHTML={{ __html: sanitizedSubtitle }}
            />
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="px-2 py-1.5 max-w-none flex items-center justify-center"
          >
            <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap leading-none">
              {tooltipContent}
            </span>
          </TooltipContent>
        </Tooltip>
      ) : (
        <span
          className={subtitleClassName}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify (ALLOWED_TAGS: span, ALLOWED_ATTR: style)
          dangerouslySetInnerHTML={{ __html: sanitizedSubtitle }}
        />
      )
    ) : null;

    return (
      <div
        className={cn('flex items-start gap-1.5 py-0.5', isNested ? 'px-2.5' : 'rounded-md px-2')}
      >
        {/* Icon container - commented out like canvas, uncomment to show icons */}
        {/* <div className="shrink-0 flex text-muted-foreground items-start pt-px">
          <_Icon className="w-3.5 h-3.5" />
        </div> */}

        {/* Content container - matches canvas exactly */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div
            className={cn(
              'text-xs text-muted-foreground flex gap-1.5 min-w-0',
              allowWrap && 'flex-wrap items-baseline',
            )}
          >
            <span
              className={
                allowWrap
                  ? 'font-medium wrap-break-word shrink-0 min-w-0'
                  : 'font-medium whitespace-nowrap shrink-0'
              }
            >
              {isPending ? (
                <TextShimmer
                  as="span"
                  duration={1.2}
                  variant={titleShimmerVariant}
                  className="inline-flex items-center text-xs leading-none h-4 m-0"
                >
                  {titleStr}
                </TextShimmer>
              ) : (
                titleStr
              )}
            </span>
            {subtitleElement}
          </div>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison for memoization (copied from canvas)
    return (
      prevProps.title === nextProps.title &&
      prevProps.subtitle === nextProps.subtitle &&
      prevProps.tooltipContent === nextProps.tooltipContent &&
      prevProps.isPending === nextProps.isPending &&
      prevProps.isError === nextProps.isError &&
      prevProps.isNested === nextProps.isNested &&
      prevProps.allowWrap === nextProps.allowWrap &&
      prevProps.titleShimmerVariant === nextProps.titleShimmerVariant
    );
  },
);
