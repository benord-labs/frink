/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { Check, Copy } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { parseMarkdownIntoBlocks, Streamdown, type StreamdownProps } from 'streamdown';
import { isAllowedShellOpenExternalUrl } from '../../shared/shell-external-url';
import { hashString } from '../lib/hash';
import { useCodeTheme } from '../lib/hooks/use-code-theme';
import { highlightCode } from '../lib/themes/shiki-theme-loader';
import { cn } from '../lib/utils';
import { MermaidBlock } from './MermaidBlock';

// Extract the Components type from StreamdownProps
type StreamdownComponents = StreamdownProps['components'];

/**
 * Stable remark plugin list — hoisted so every <Streamdown /> receives the same
 * array reference. An inline `[remarkGfm, remarkBreaks]` creates a new array on
 * each render and defeats Streamdown/react-markdown's internal memoization.
 * @internal exported for unit tests that verify reference stability
 */
export const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

// Regex patterns for emoji stripping - hoisted to module level for performance
const EMOJI_EMOTICONS_REGEX = /[\u{1F600}-\u{1F64F}]/gu;
const EMOJI_SYMBOLS_REGEX = /[\u{1F300}-\u{1F5FF}]/gu;
const EMOJI_TRANSPORT_REGEX = /[\u{1F680}-\u{1F6FF}]/gu;
const EMOJI_FLAGS_REGEX = /[\u{1F1E0}-\u{1F1FF}]/gu;
const EMOJI_SUPPLEMENTAL_REGEX = /[\u{1F900}-\u{1F9FF}]/gu;
const EMOJI_EXTENDED_REGEX = /[\u{1FA00}-\u{1FAFF}]/gu;
const EMOJI_DINGBATS_REGEX = /[\u{2700}-\u{27BF}]/gu;

// Regex patterns for HTML escaping - hoisted to module level for performance
const HTML_AMPERSAND_REGEX = /&/g;
const HTML_LESS_THAN_REGEX = /</g;
const HTML_GREATER_THAN_REGEX = />/g;

/**
 * Aggressive Unicode block cleanup (emoji ranges, dingbats, flags, etc.) — not exact
 * "emoji only." Prefer leaving this off; use when a legacy view needs stripped output.
 */
export function stripEmojis(text: string): string {
  return text
    .replace(EMOJI_EMOTICONS_REGEX, '') // Emoticons
    .replace(EMOJI_SYMBOLS_REGEX, '') // Misc Symbols and Pictographs
    .replace(EMOJI_TRANSPORT_REGEX, '') // Transport and Map
    .replace(EMOJI_FLAGS_REGEX, '') // Flags
    .replace(EMOJI_SUPPLEMENTAL_REGEX, '') // Supplemental Symbols
    .replace(EMOJI_EXTENDED_REGEX, '') // Extended-A
    .replace(EMOJI_DINGBATS_REGEX, ''); // Dingbats
}

// Regex to extract language from className
const LANGUAGE_REGEX = /language-(\w+)/;

// Regex to remove trailing newlines from code content
const TRAILING_NEWLINE_REGEX = /\n$/;

// Escape HTML special characters for safe rendering
function escapeHtml(text: string): string {
  return text
    .replace(HTML_AMPERSAND_REGEX, '&amp;')
    .replace(HTML_LESS_THAN_REGEX, '&lt;')
    .replace(HTML_GREATER_THAN_REGEX, '&gt;');
}

// Code block text sizes matching paragraph text sizes
const codeBlockTextSize = {
  sm: 'text-sm',
  md: 'text-sm',
  lg: 'text-sm',
};

// Code block with copy button using Shiki
function CodeBlock({
  language,
  children,
  themeId,
  size = 'md',
}: {
  language?: string;
  children: string;
  themeId: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  // Only use Shiki for known programming languages, not for plaintext/ASCII art
  const shouldHighlight = language && language !== 'plaintext' && language !== 'text';

  useEffect(() => {
    if (!shouldHighlight) return;

    let cancelled = false;

    const highlight = async () => {
      try {
        const html = await highlightCode(children, language, themeId);
        if (!cancelled) {
          setHighlightedHtml(html);
        }
      } catch {
        // Intentionally swallow highlight failures so rendering falls back to escapeHtml content.
      }
    };

    highlight();

    return () => {
      cancelled = true;
    };
  }, [children, language, themeId, shouldHighlight]);

  // For plaintext/ASCII art, just escape and render directly (no Shiki)
  // For code with syntax highlighting, use Shiki output when available
  const htmlContent = shouldHighlight
    ? (highlightedHtml ?? escapeHtml(children))
    : escapeHtml(children);

  return (
    <div className="relative mt-2 mb-4 rounded-[10px] bg-muted/50 overflow-hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        tabIndex={-1}
        className="absolute top-[6px] right-[6px] p-1 z-2 hover:bg-transparent"
        title={copied ? 'Copied!' : 'Copy code'}
      >
        <div className="relative w-3.5 h-3.5">
          <Copy
            className={cn(
              'absolute inset-0 w-3 h-3 text-muted-foreground transition-[opacity,transform] duration-200 ease-out hover:text-foreground',
              copied ? 'opacity-0 scale-50' : 'opacity-100 scale-100',
            )}
          />
          <Check
            className={cn(
              'absolute inset-0 w-3 h-3 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
              copied ? 'opacity-100 scale-100' : 'opacity-0 scale-50',
            )}
          />
        </div>
      </Button>
      <pre
        className={cn(
          'm-0 bg-transparent',
          'text-foreground',
          codeBlockTextSize[size],
          'px-4 py-3',
          'overflow-x-auto',
          'whitespace-pre',
          // Force all nested elements to preserve whitespace and have no background
          '**:whitespace-pre **:bg-transparent',
          '[&_pre]:m-0 [&_code]:m-0',
          '[&_pre]:p-0 [&_code]:p-0',
        )}
        style={{
          fontFamily:
            "SFMono-Regular, Menlo, Consolas, 'PT Mono', 'Liberation Mono', Courier, monospace",
          lineHeight: 1.5,
          tabSize: 2,
        }}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: htmlContent is safely sanitized
            via escapeHtml() for plain text or Shiki for syntax highlighting */}
        <code dangerouslySetInnerHTML={{ __html: htmlContent }} />
      </pre>
    </div>
  );
}

type MarkdownSize = 'sm' | 'md' | 'lg';

type ChatMarkdownRendererProps = {
  content: string;
  /** Size variant: sm for compact views, md for normal, lg for fullscreen */
  size?: MarkdownSize;
  /** Additional className for the wrapper */
  className?: string;
  /** Whether to enable syntax highlighting (default: true) */
  syntaxHighlight?: boolean;
  /** Whether content is being streamed */
  isStreaming?: boolean;
  /**
   * When true, applies {@link stripEmojis} before render (legacy / aggressive cleanup).
   * Default false preserves Unicode emoji in chat and tool panels.
   */
  stripEmojis?: boolean;
};

// Size-based styles inspired by Notion's spacing
const sizeStyles: Record<
  MarkdownSize,
  {
    h1: string;
    h2: string;
    h3: string;
    h4: string;
    h5: string;
    h6: string;
    p: string;
    ul: string;
    ol: string;
    li: string;
    inlineCode: string;
    blockquote: string;
    hr: string;
    table: string;
    thead: string;
    tbody: string;
    tr: string;
    th: string;
    td: string;
  }
> = {
  sm: {
    h1: 'text-base font-semibold text-foreground mt-[1.4em] mb-px first:mt-0 leading-[1.3]',
    h2: 'text-base font-semibold text-foreground mt-[1.4em] mb-px first:mt-0 leading-[1.3]',
    h3: 'text-sm font-semibold text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h4: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h5: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h6: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    p: 'text-sm text-foreground/80 my-px leading-normal py-[3px]',
    ul: 'list-disc list-inside text-sm text-foreground/80 mb-px marker:text-foreground/60',
    ol: 'list-decimal list-inside text-sm text-foreground/80 mb-px marker:text-foreground/60',
    li: 'text-sm text-foreground/80 py-[3px]',
    inlineCode:
      'bg-foreground/6 dark:bg-foreground/10 font-mono text-[85%] rounded px-[0.4em] py-[0.2em] break-all',
    blockquote: 'border-l-2 border-foreground/20 pl-3 text-foreground/70 mb-px text-sm',
    hr: 'mt-8 mb-4 border-t border-border',
    table: 'w-full text-sm',
    thead: 'border-b border-border',
    tbody: '',
    tr: 'not-last:border-b not-last:border-border',
    th: 'text-left text-sm font-medium text-foreground px-3 py-2 bg-muted/50 border-r border-border last:border-r-0',
    td: 'text-sm text-foreground/80 px-3 py-2 border-r border-border last:border-r-0',
  },
  md: {
    h1: 'text-[1.5em] font-semibold text-foreground mt-[1.4em] mb-px first:mt-0 leading-[1.3]',
    h2: 'text-[1.5em] font-semibold text-foreground mt-[1.4em] mb-px first:mt-0 leading-[1.3]',
    h3: 'text-[1.25em] font-semibold text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h4: 'text-base font-semibold text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h5: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h6: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    p: 'text-sm text-foreground/80 my-px leading-normal py-[3px]',
    ul: 'list-disc list-inside text-sm text-foreground/80 mb-px marker:text-foreground/60',
    ol: 'list-decimal list-inside text-sm text-foreground/80 mb-px marker:text-foreground/60',
    li: 'text-sm text-foreground/80 py-[3px]',
    inlineCode:
      'bg-foreground/6 dark:bg-foreground/10 font-mono text-[85%] rounded px-[0.4em] py-[0.2em] break-all',
    blockquote: 'border-l-2 border-foreground/20 pl-4 text-foreground/70 mb-px',
    hr: 'mt-8 mb-4 border-t border-border',
    table: 'w-full text-sm',
    thead: 'border-b border-border',
    tbody: '',
    tr: 'not-last:border-b not-last:border-border',
    th: 'text-left text-sm font-medium text-foreground px-3 py-2 bg-muted/50 border-r border-border last:border-r-0',
    td: 'text-sm text-foreground/80 px-3 py-2 border-r border-border last:border-r-0',
  },
  lg: {
    h1: 'text-[1.875em] font-semibold text-foreground mt-[1.4em] mb-px first:mt-0 leading-[1.3]',
    h2: 'text-[1.5em] font-semibold text-foreground mt-[1.4em] mb-px first:mt-0 leading-[1.3]',
    h3: 'text-[1.25em] font-semibold text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h4: 'text-base font-semibold text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h5: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    h6: 'text-sm font-medium text-foreground mt-[1em] mb-px first:mt-0 leading-[1.3]',
    p: 'text-sm text-foreground/80 my-px leading-normal py-[3px]',
    ul: 'list-disc list-inside text-sm text-foreground/80 mb-px marker:text-foreground/60',
    ol: 'list-decimal list-inside text-sm text-foreground/80 mb-px marker:text-foreground/60',
    li: 'text-sm text-foreground/80 py-[3px]',
    inlineCode:
      'bg-foreground/6 dark:bg-foreground/10 font-mono text-[85%] rounded px-[0.4em] py-[0.2em] break-all',
    blockquote: 'border-l-2 border-foreground/20 pl-4 text-foreground/70 mb-px',
    hr: 'mt-8 mb-4 border-t border-border',
    table: 'w-full text-sm',
    thead: 'border-b border-border',
    tbody: '',
    tr: 'not-last:border-b not-last:border-border',
    th: 'text-left text-sm font-medium text-foreground px-3 py-2 bg-muted/50 border-r border-border last:border-r-0',
    td: 'text-sm text-foreground/80 px-3 py-2 border-r border-border last:border-r-0',
  },
};

// Custom code component that uses our theme system
function createCodeComponent(
  codeTheme: string,
  size: MarkdownSize,
  styles: typeof sizeStyles.md,
  isStreaming: boolean = false,
) {
  return function CodeComponent({
    className,
    children,
  }: {
    className?: string;
    children?: React.ReactNode;
  }) {
    const match = LANGUAGE_REGEX.exec(className || '');
    const language = match ? match[1] : undefined;
    const codeContent = String(children);

    // Check if this is a code block (has language) or inline code
    // Streamdown wraps code blocks in <pre><code>, inline code is just <code>
    const isCodeBlock = language || (codeContent.includes('\n') && codeContent.length > 100);

    if (isCodeBlock) {
      // While streaming, MermaidBlock waits for the source to settle before drawing
      if (language === 'mermaid') {
        return (
          <MermaidBlock
            code={codeContent.replace(TRAILING_NEWLINE_REGEX, '')}
            isStreaming={isStreaming}
          />
        );
      }

      return (
        <CodeBlock language={language} themeId={codeTheme} size={size}>
          {codeContent.replace(TRAILING_NEWLINE_REGEX, '')}
        </CodeBlock>
      );
    }

    // Inline code
    return <span className={styles.inlineCode}>{children}</span>;
  };
}

// Build the Streamdown `components` object for a given (size, codeTheme, isStreaming).
// Pure and deterministic — safe to cache by a composite key so every block/renderer
// shares the same reference (and react-markdown's internal memoization can bail out).
function buildStreamdownComponents(
  size: MarkdownSize,
  codeTheme: string,
  isStreaming: boolean,
): StreamdownComponents {
  const styles = sizeStyles[size];
  // Cast mirrors the previous inline usage (`components={components as StreamdownComponents}`).
  // Streamdown's component typings use strict per-tag HTMLAttributes; our loose
  // `[key: string]: unknown` prop shape matches at runtime but not structurally.
  const builtComponents = {
    h1: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <h1 className={styles.h1} {...props}>
        {children}
      </h1>
    ),
    h2: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <h2 className={styles.h2} {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <h3 className={styles.h3} {...props}>
        {children}
      </h3>
    ),
    h4: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <h4 className={styles.h4} {...props}>
        {children}
      </h4>
    ),
    h5: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <h5 className={styles.h5} {...props}>
        {children}
      </h5>
    ),
    h6: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <h6 className={styles.h6} {...props}>
        {children}
      </h6>
    ),
    p: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <p className={styles.p} {...props}>
        {children}
      </p>
    ),
    ul: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <ul className={styles.ul} {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <ol className={styles.ol} {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <li className={styles.li} {...props}>
        {children}
      </li>
    ),
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href && isAllowedShellOpenExternalUrl(href)) {
            void window.desktopApi.openExternal(href);
          }
        }}
        className="text-blue-600 dark:text-blue-400 no-underline hover:underline hover:decoration-current underline-offset-2 decoration-1 transition-all duration-150 cursor-pointer focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-blue-500/30 focus-visible:rounded-sm"
        {...props}
      >
        {children}
      </a>
    ),
    strong: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <strong className="font-medium text-foreground" {...props}>
        {children}
      </strong>
    ),
    em: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <em className="italic" {...props}>
        {children}
      </em>
    ),
    blockquote: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => (
      <blockquote className={styles.blockquote} {...props}>
        {children}
      </blockquote>
    ),
    hr: ({ ...props }: { [key: string]: unknown }) => <hr className={styles.hr} {...props} />,
    table: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div className="overflow-x-auto my-3 rounded-lg border border-border overflow-hidden">
        <table className={cn(styles.table, 'border-collapse')} {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <thead className={styles.thead} {...props}>
        {children}
      </thead>
    ),
    tbody: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <tbody className={styles.tbody} {...props}>
        {children}
      </tbody>
    ),
    tr: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <tr className={styles.tr} {...props}>
        {children}
      </tr>
    ),
    th: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <th className={styles.th} {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <td className={styles.td} {...props}>
        {children}
      </td>
    ),
    pre: ({ children }: { children?: React.ReactNode; [key: string]: unknown }) => <>{children}</>,
    code: createCodeComponent(codeTheme, size, sizeStyles[size], isStreaming),
  };
  return builtComponents as unknown as StreamdownComponents;
}

// Module-level cache so every renderer/block with the same (size, codeTheme, isStreaming)
// shares ONE components reference. Without this, 120 MemoizedMarkdownBlock instances each
// built their own useMemo'd object (same shape, different refs) — defeating Streamdown's
// internal memo and forcing react-markdown (`Ct`) to re-render on every parent update.
const componentsCache = new Map<string, StreamdownComponents>();

/**
 * Returns a cached Streamdown `components` object for the given (size, codeTheme,
 * isStreaming) tuple. The cache is module-level so every block/renderer with the
 * same inputs shares ONE reference — this is what lets Streamdown's internal
 * memoization skip re-rendering `Ct` (react-markdown) when only siblings updated.
 * @internal exported for unit tests that verify the cache contract
 */
export function getStreamdownComponents(
  size: MarkdownSize,
  codeTheme: string,
  isStreaming: boolean,
): StreamdownComponents {
  const key = `${size}|${codeTheme}|${isStreaming ? 1 : 0}`;
  let components = componentsCache.get(key);
  if (!components) {
    components = buildStreamdownComponents(size, codeTheme, isStreaming);
    componentsCache.set(key, components);
  }
  return components;
}

export const ChatMarkdownRenderer = memo(function ChatMarkdownRenderer({
  content,
  size = 'md',
  className,
  isStreaming = false,
  stripEmojis: shouldStripEmojis = false,
}: ChatMarkdownRendererProps) {
  const codeTheme = useCodeTheme();

  const processedContent = useMemo(
    () => (shouldStripEmojis ? stripEmojis(content) : content),
    [content, shouldStripEmojis],
  );

  const components = getStreamdownComponents(size, codeTheme, isStreaming);

  return (
    <div
      className={cn(
        'prose prose-sm max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none',
        // Reset prose margins - we use our own compact Notion-like spacing
        'prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0',
        'prose-ul:pl-0 prose-ol:pl-0 prose-li:pl-0',
        // Reset prose hr margins - we use our own
        'prose-hr:my-0',
        // Reset prose table margins - we use our own wrapper with margins
        'prose-table:my-0',
        // Fix for p inside li - make it inline so numbered list items don't break
        '[&_li>p]:inline [&_li>p]:mb-0',
        // Prevent horizontal overflow on mobile
        'overflow-hidden wrap-break-word',
        // Global spacing: elements before hr get extra bottom margin (for spacing above divider)
        '[&_p:has(+hr)]:mb-6 [&_ul:has(+hr)]:mb-6 [&_ol:has(+hr)]:mb-6 [&_div:has(+hr)]:mb-6 [&_table:has(+hr)]:mb-6 [&_h1:has(+hr)]:mb-6 [&_h2:has(+hr)]:mb-6 [&_h3:has(+hr)]:mb-6 [&_blockquote:has(+hr)]:mb-6',
        // Global spacing: elements after hr get extra top margin
        '[&_hr+p]:mt-4 [&_hr+ul]:mt-4 [&_hr+ol]:mt-4',
        // Global spacing: elements after code blocks get extra top margin
        '[&_div+p]:mt-2 [&_div+ul]:mt-2 [&_div+ol]:mt-2',
        // Global spacing: elements after tables get extra top margin
        '[&_table+p]:mt-4 [&_table+ul]:mt-4 [&_table+ol]:mt-4',
        className,
      )}
    >
      <Streamdown
        mode="streaming"
        components={components}
        remarkPlugins={REMARK_PLUGINS}
        isAnimating={isStreaming}
        parseIncompleteMarkdown={isStreaming}
        controls={false}
        skipHtml
      >
        {processedContent}
      </Streamdown>
    </div>
  );
});

// ============================================================================
// MEMOIZED MARKDOWN - Block-level memoization for streaming performance
// ============================================================================
// This is the KEY optimization for streaming performance!
// Instead of re-rendering the entire markdown on each chunk, we:
// 1. Parse markdown into discrete blocks (paragraphs, headers, code blocks, etc.)
// 2. Memoize each block individually with content-based keys
// 3. Only the last (incomplete) block re-renders during streaming
//
// Streamdown's internal memoization only works within a single render pass.
// When the parent component re-renders (due to atom update), Streamdown
// re-renders all blocks. This external block-level memoization prevents that.

type ParsedBlock = {
  content: string;
  // Stable key based on: content hash + occurrence index
  key: string;
};

function parseIntoBlocks(markdown: string): ParsedBlock[] {
  try {
    // Use Streamdown's built-in parser for consistency
    const blocks = parseMarkdownIntoBlocks(markdown);
    // Track occurrences of each content hash to handle duplicates
    const seen = new Map<string, number>();
    return blocks.map((content) => {
      const baseKey = hashString(content);
      const occurrence = seen.get(baseKey) ?? 0;
      seen.set(baseKey, occurrence + 1);
      const key = occurrence > 0 ? `${baseKey}-${occurrence}` : baseKey;
      return { content, key };
    });
  } catch {
    // Fallback: return entire content as single block
    return [{ content: markdown, key: `fallback-${hashString(markdown)}` }];
  }
}

// Individual block - only re-renders when its content changes
const MemoizedMarkdownBlock = memo(
  function MemoizedMarkdownBlock({
    content,
    size,
    codeTheme,
  }: {
    content: string;
    size: MarkdownSize;
    codeTheme: string;
  }) {
    // Shared across all blocks with the same (size, codeTheme) — module-level cache
    // keeps the reference stable so Streamdown/react-markdown can skip re-renders
    // when only unrelated siblings updated.
    const components = getStreamdownComponents(size, codeTheme, false);

    // Don't render empty blocks
    if (!content.trim()) return null;

    return (
      <Streamdown
        mode="static"
        components={components}
        remarkPlugins={REMARK_PLUGINS}
        controls={false}
        skipHtml
      >
        {content}
      </Streamdown>
    );
  },
  (prevProps, nextProps) => {
    // Only re-render if content or styling actually changed
    return (
      prevProps.content === nextProps.content &&
      prevProps.size === nextProps.size &&
      prevProps.codeTheme === nextProps.codeTheme
    );
  },
);

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock';

// Main memoized markdown component - splits into blocks and memoizes each
export const MemoizedMarkdown = memo(
  function MemoizedMarkdown({
    content,
    id,
    size = 'sm',
    className,
    stripEmojis: shouldStripEmojis = false,
  }: {
    content: string;
    id: string;
    size?: MarkdownSize;
    className?: string;
    /**
     * When true, applies {@link stripEmojis} before parsing (legacy / aggressive cleanup).
     * Default false matches user bubbles and shows emoji in assistant markdown.
     */
    stripEmojis?: boolean;
  }) {
    const codeTheme = useCodeTheme();

    const processedContent = useMemo(
      () => (shouldStripEmojis ? stripEmojis(content) : content),
      [content, shouldStripEmojis],
    );

    // Split into blocks - this recalculates when content changes,
    // but each block is individually memoized with content-based keys
    const blocks = useMemo(() => parseIntoBlocks(processedContent), [processedContent]);

    return (
      <div
        className={cn(
          'prose prose-sm max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none',
          'prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0',
          'prose-ul:pl-0 prose-ol:pl-0 prose-li:pl-0',
          'prose-hr:my-0',
          'prose-table:my-0',
          '[&_li>p]:inline [&_li>p]:mb-0',
          'overflow-hidden wrap-break-word',
          '[&_p:has(+hr)]:mb-6 [&_ul:has(+hr)]:mb-6 [&_ol:has(+hr)]:mb-6 [&_div:has(+hr)]:mb-6 [&_table:has(+hr)]:mb-6 [&_h1:has(+hr)]:mb-6 [&_h2:has(+hr)]:mb-6 [&_h3:has(+hr)]:mb-6 [&_blockquote:has(+hr)]:mb-6',
          '[&_hr+p]:mt-4 [&_hr+ul]:mt-4 [&_hr+ol]:mt-4',
          '[&_div+p]:mt-2 [&_div+ul]:mt-2 [&_div+ol]:mt-2',
          '[&_table+p]:mt-4 [&_table+ul]:mt-4 [&_table+ol]:mt-4',
          className,
        )}
      >
        {blocks.map((block) => (
          <MemoizedMarkdownBlock
            key={`${id}-${block.key}`}
            content={block.content}
            size={size}
            codeTheme={codeTheme}
          />
        ))}
      </div>
    );
  },
  (prev, next) =>
    prev.content === next.content &&
    prev.id === next.id &&
    prev.size === next.size &&
    prev.className === next.className &&
    prev.stripEmojis === next.stripEmojis,
);

MemoizedMarkdown.displayName = 'MemoizedMarkdown';
