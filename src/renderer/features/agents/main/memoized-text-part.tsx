import { memo, useEffect, useMemo, useRef } from 'react';
import { MemoizedMarkdown } from '../../../components/chat-markdown-renderer';
import { cn } from '../../../lib/utils';
import { useSearchHighlight, useSearchQuery } from '../search';
import { DebugReproduceCard } from '../ui/debug-reproduce-card';

type TextSegment = {
  type: 'text' | 'reproduce';
  content: string;
};

type ReproduceMatch = {
  /** Position of the opening `<reproduce>` tag. */
  openStart: number;
  /** Position immediately after the closing `</reproduce>` (or `text.length` for unclosed). */
  closeEnd: number;
  /** Trimmed inner content. */
  content: string;
  /** Whether the open tag sits inside a markdown code region. */
  inCode: boolean;
};

/** A code region and the position to resume scanning from. `range` is null when none was found. */
type CodeScan = { range: [number, number] | null; next: number };

/**
 * Scan the fenced block (``` … ```) opening at `start`. An unterminated fence
 * covers the rest of the text, matching how a markdown renderer treats it.
 */
function scanFencedBlock(text: string, start: number): CodeScan {
  let openLen = 3;
  while (text[start + openLen] === '`') openLen++;

  const openLineEnd = text.indexOf('\n', start + openLen);
  if (openLineEnd === -1) return { range: [start, text.length], next: text.length };

  // `\r` keeps CRLF fences closable; without it they run to end-of-text.
  const closeRe = new RegExp(`\\n\`{${openLen},}[ \\t\\r]*(?:\\n|$)`, 'g');
  closeRe.lastIndex = openLineEnd;
  const closeMatch = closeRe.exec(text);
  if (!closeMatch) return { range: [start, text.length], next: text.length };

  const end = closeMatch.index + closeMatch[0].length;
  return { range: [start, end], next: end };
}

/**
 * Scan the inline code span opening at `start`. It must close on the same line
 * with an equal-length backtick run; otherwise only the backticks are consumed.
 */
function scanInlineCode(text: string, start: number): CodeScan {
  let openLen = 0;
  while (text[start + openLen] === '`') openLen++;
  const openEnd = start + openLen;

  let j = openEnd;
  while (j < text.length && text[j] !== '\n') {
    if (text[j] !== '`') {
      j++;
      continue;
    }
    let runLen = 0;
    while (text[j + runLen] === '`') runLen++;
    if (runLen === openLen) return { range: [start, j + runLen], next: j + runLen };
    j += runLen;
  }

  return { range: null, next: openEnd };
}

/**
 * Returns half-open [start, end) ranges in `text` that are inside a markdown
 * code region — either a fenced block (``` … ```) or an inline code span
 * (` … `). Used by `splitReproduceBlocks` to skip unclosed `<reproduce>` tags
 * sitting inside inline code (e.g. prose explaining the convention) so they
 * don't gobble the rest of the message.
 */
function findCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }

    const isLineStart = i === 0 || text[i - 1] === '\n';
    const isFence = isLineStart && text[i + 1] === '`' && text[i + 2] === '`';
    const { range, next } = isFence ? scanFencedBlock(text, i) : scanInlineCode(text, i);

    if (range) ranges.push(range);
    i = next;
  }

  return ranges;
}

const CLOSE_TAG = '</reproduce>';

/**
 * Drop a trailing prefix of `</reproduce>`: the closing tag arrives a character
 * at a time, and a half-arrived one must not surface as a step.
 */
function trimPartialCloseTag(text: string): string {
  for (let len = CLOSE_TAG.length - 1; len > 0; len--) {
    if (text.endsWith(CLOSE_TAG.slice(0, len))) return text.slice(0, -len);
  }
  return text;
}

/**
 * Find every `<reproduce>…</reproduce>` block in `text`. An unclosed
 * `<reproduce>` inside an inline code span is treated as a literal mention
 * (skipped); an unclosed `<reproduce>` outside of code is treated as a
 * streaming-card-in-progress that runs to end-of-text.
 */
function findReproduceMatches(text: string, isInCode: (pos: number) => boolean): ReproduceMatch[] {
  const matches: ReproduceMatch[] = [];
  const open = '<reproduce>';
  let scan = 0;

  while (scan < text.length) {
    const openIdx = text.indexOf(open, scan);
    if (openIdx === -1) break;

    const contentStart = openIdx + open.length;
    const closeIdx = text.indexOf(CLOSE_TAG, contentStart);
    const openInCode = isInCode(openIdx);

    if (closeIdx !== -1) {
      const closeInCode = isInCode(closeIdx);
      // Open and close must agree on their code context — otherwise the open is
      // a stray mention (e.g. "`<reproduce>`" in prose) that incidentally
      // precedes a real, unrelated closing tag. Skip past the open and resume
      // so the next iteration finds the genuine pair.
      if (openInCode !== closeInCode) {
        scan = contentStart;
        continue;
      }
      matches.push({
        openStart: openIdx,
        closeEnd: closeIdx + CLOSE_TAG.length,
        content: text.slice(contentStart, closeIdx).trim(),
        inCode: openInCode,
      });
      scan = closeIdx + CLOSE_TAG.length;
      continue;
    }

    // Unclosed. An in-code unclosed mention (e.g. "inside a `<reproduce>` …")
    // is literal — skip it so it doesn't gobble the rest of the message.
    if (openInCode) {
      scan = contentStart;
      continue;
    }

    matches.push({
      openStart: openIdx,
      closeEnd: text.length,
      content: trimPartialCloseTag(text.slice(contentStart).trim()).trim(),
      inCode: false,
    });
    break;
  }

  return matches;
}

/**
 * Split message text into a text segment plus an optional trailing reproduce
 * segment. Contract: decision `debug-reproduce-block-rendering`.
 */
export function splitReproduceBlocks(text: string): TextSegment[] {
  const codeRanges = findCodeRanges(text);
  const isInCode = (pos: number) => codeRanges.some(([s, e]) => pos >= s && pos < e);
  const matches = findReproduceMatches(text, isInCode);

  // Content required: a later EMPTY block is a stray tag, not a retraction.
  const active = [...matches].reverse().find((m) => !m.inCode && m.content);

  let body = '';
  let cursor = 0;
  for (const m of matches) {
    body += text.slice(cursor, m.openStart);
    cursor = m.closeEnd;
  }
  body += text.slice(cursor);

  const segments: TextSegment[] = [];
  if (body.trim()) segments.push({ type: 'text', content: body });
  if (active) segments.push({ type: 'reproduce', content: active.content });

  return segments;
}

type MemoizedTextPartProps = {
  text: string;
  messageId: string;
  partIndex: number;
  isFinalText: boolean;
  visibleStepsCount: number;
  isStreaming?: boolean;
  /** When false, render the text verbatim instead of as markdown (raw toggle). */
  renderMarkdown: boolean;
};

/** Render one text segment as markdown or as verbatim raw text, per the toggle. */
function TextSegmentBody({
  content,
  id,
  renderMarkdown,
}: {
  content: string;
  id: string;
  renderMarkdown: boolean;
}) {
  if (!renderMarkdown) {
    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm text-foreground">{content}</div>
    );
  }
  return <MemoizedMarkdown content={content} id={id} size="sm" />;
}

// Helper function to highlight text in DOM using TreeWalker
function highlightTextInDom(
  container: HTMLElement,
  searchText: string,
  currentMatchIndex: number | null = null,
) {
  // Remove existing highlights first
  const existingHighlights = container.querySelectorAll('.search-highlight');
  existingHighlights.forEach((el) => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent || ''), el);
      parent.normalize();
    }
  });

  if (!searchText) return;

  const lowerSearch = searchText.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  let node: Text | null = walker.nextNode() as Text | null;
  while (node) {
    if (node.nodeValue?.toLowerCase().includes(lowerSearch)) {
      textNodes.push(node);
    }
    node = walker.nextNode() as Text | null;
  }

  let matchCounter = 0;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || '';
    const lowerText = text.toLowerCase();
    let lastIndex = 0;
    const fragments: (string | HTMLElement)[] = [];

    let searchIndex = lowerText.indexOf(lowerSearch, lastIndex);
    while (searchIndex !== -1) {
      if (searchIndex > lastIndex) {
        fragments.push(text.slice(lastIndex, searchIndex));
      }

      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.slice(searchIndex, searchIndex + searchText.length);

      if (currentMatchIndex !== null && matchCounter === currentMatchIndex) {
        mark.classList.add('search-highlight-current');
      }
      matchCounter++;

      fragments.push(mark);
      lastIndex = searchIndex + searchText.length;
      searchIndex = lowerText.indexOf(lowerSearch, lastIndex);
    }

    if (lastIndex < text.length) {
      fragments.push(text.slice(lastIndex));
    }

    if (fragments.length > 0) {
      const parent = textNode.parentNode;
      if (parent) {
        fragments.forEach((frag) => {
          if (typeof frag === 'string') {
            parent.insertBefore(document.createTextNode(frag), textNode);
          } else {
            parent.insertBefore(frag, textNode);
          }
        });
        parent.removeChild(textNode);
      }
    }
  }
}

// Inner component - pure render, no hooks that cause re-renders
// Only re-renders when props change (text, styling props)
const MemoizedTextPartInner = memo(
  function MemoizedTextPartInner({
    text,
    messageId,
    partIndex,
    isFinalText,
    visibleStepsCount,
    renderMarkdown,
  }: Omit<MemoizedTextPartProps, 'isStreaming'>) {
    const segments = useMemo(() => splitReproduceBlocks(text), [text]);

    if (!text?.trim() || !segments.length) return null;

    return (
      <div
        className={cn('text-foreground px-2', isFinalText && visibleStepsCount > 0 && 'pt-3')}
        data-message-id={messageId}
        data-part-index={partIndex}
        data-part-type="text"
      >
        {isFinalText && visibleStepsCount > 0 && (
          <div className="text-[12px] uppercase tracking-wider text-muted-foreground/60 font-medium mb-1">
            Response
          </div>
        )}
        {/* Split segments, never verbatim text: raw mode must not dump stripped steps.
            The stable card key keeps it mounted as text appears ahead of it mid-stream. */}
        {segments.map((seg, idx) =>
          seg.type === 'reproduce' ? (
            <DebugReproduceCard key="reproduce" content={seg.content} />
          ) : (
            <TextSegmentBody
              key={idx}
              content={seg.content}
              id={`${messageId}-${partIndex}-${idx}`}
              renderMarkdown={renderMarkdown}
            />
          ),
        )}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.text === next.text &&
      prev.messageId === next.messageId &&
      prev.partIndex === next.partIndex &&
      prev.isFinalText === next.isFinalText &&
      prev.visibleStepsCount === next.visibleStepsCount &&
      prev.renderMarkdown === next.renderMarkdown
    );
  },
);

// Outer component - handles search highlighting via DOM manipulation
// This may re-render when search changes, but the inner MemoizedTextPartInner won't
// because its props (text, etc.) haven't changed
export const MemoizedTextPart = memo(
  function MemoizedTextPart({
    text,
    messageId,
    partIndex,
    isFinalText,
    visibleStepsCount,
    isStreaming = false,
    renderMarkdown,
  }: MemoizedTextPartProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    // Search hooks - when search is closed, these return empty/null values
    // and don't cause re-renders (SearchHighlightProvider returns static context)
    const searchQuery = useSearchQuery();
    const highlights = useSearchHighlight(messageId, partIndex, 'text');
    const currentHighlight = highlights.find((h) => h.isCurrent);
    const currentMatchIndexInPart = currentHighlight?.indexInPart ?? null;

    // Apply DOM-based highlighting after render
    // Skip during streaming to avoid performance issues
    useEffect(() => {
      if (!containerRef.current || isStreaming || !searchQuery) return;

      highlightTextInDom(containerRef.current, searchQuery, currentMatchIndexInPart);

      return () => {
        if (containerRef.current) {
          const existingHighlights = containerRef.current.querySelectorAll('.search-highlight');
          existingHighlights.forEach((el) => {
            const parent = el.parentNode;
            if (parent) {
              parent.replaceChild(document.createTextNode(el.textContent || ''), el);
              parent.normalize();
            }
          });
        }
      };
    }, [searchQuery, currentMatchIndexInPart, isStreaming]);

    if (!text?.trim()) return null;

    return (
      <div ref={containerRef}>
        <MemoizedTextPartInner
          text={text}
          messageId={messageId}
          partIndex={partIndex}
          isFinalText={isFinalText}
          visibleStepsCount={visibleStepsCount}
          renderMarkdown={renderMarkdown}
        />
      </div>
    );
  },
  (prev, next) => {
    // Only re-render outer component when these props change
    // Search-related re-renders happen but inner component stays memoized
    return (
      prev.text === next.text &&
      prev.messageId === next.messageId &&
      prev.partIndex === next.partIndex &&
      prev.isFinalText === next.isFinalText &&
      prev.visibleStepsCount === next.visibleStepsCount &&
      prev.isStreaming === next.isStreaming &&
      prev.renderMarkdown === next.renderMarkdown
    );
  },
);
