import type { ReactNode } from 'react';
import { escapeRegExp } from '../../../../shared/utils/escape-regexp';
import type { ContentSearchOptions } from '../types/content-search-options';

function createHighlightRegex(
  query: string,
  options: ContentSearchOptions,
): { splitRegex: RegExp; matchRegex: RegExp } | null {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return null;

  try {
    const source = options.useRegex
      ? options.wholeWord
        ? `\\b(${trimmedQuery})\\b`
        : `(${trimmedQuery})`
      : options.wholeWord
        ? `\\b(${escapeRegExp(trimmedQuery)})\\b`
        : `(${escapeRegExp(trimmedQuery)})`;
    const splitFlags = options.matchCase ? 'g' : 'gi';
    const matchFlags = options.matchCase ? '' : 'i';
    return {
      splitRegex: new RegExp(source, splitFlags),
      matchRegex: new RegExp(`^${source}$`, matchFlags),
    };
  } catch {
    return null;
  }
}

export function createMatchHighlighter(
  query: string,
  options: ContentSearchOptions,
): (text: string) => string | ReactNode[] {
  const regexes = createHighlightRegex(query, options);
  if (!regexes) {
    return (text: string) => text;
  }

  const { splitRegex, matchRegex } = regexes;

  return (text: string): string | ReactNode[] => {
    const parts = text.split(splitRegex);
    if (parts.length <= 1) return text;

    return parts
      .filter((part) => part.length > 0)
      .map((part, index) => {
        if (matchRegex.test(part)) {
          return (
            <mark
              // biome-ignore lint/suspicious/noArrayIndexKey: filtered split segments are ordered and stable for this render
              key={`highlight-${index}`}
              className="rounded bg-primary/30 px-0.5 text-foreground"
            >
              {part}
            </mark>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: filtered split segments are ordered and stable for this render
          <span key={`highlight-${index}`}>{part}</span>
        );
      });
  };
}
