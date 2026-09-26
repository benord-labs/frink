import type { ReactNode } from 'react';
import { escapeRegExp } from '../../shared/utils/escape-regexp';

/**
 * Pre-compiles a regex-based highlighter for a search query.
 * Memoize with `useMemo(() => createHighlightMatcher(q), [q])` to avoid
 * rebuilding the regex on every row in a virtualized list.
 */
export function createHighlightMatcher(query: string): (text: string) => ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return (text: string) => text;

  const splitRegex = new RegExp(`(${escapeRegExp(trimmed)})`, 'gi');
  const lowerQuery = trimmed.toLowerCase();

  return (text: string): ReactNode => {
    const parts = text.split(splitRegex);
    if (parts.length === 1) return text;

    let cursor = 0;
    return parts.map((part) => {
      const key = `${cursor}-${part}`;
      cursor += part.length;
      if (part.toLowerCase() !== lowerQuery) return <span key={`plain-${key}`}>{part}</span>;
      return (
        <mark key={`match-${key}`} className="rounded bg-primary/40 px-0.5 text-foreground">
          {part}
        </mark>
      );
    });
  };
}
