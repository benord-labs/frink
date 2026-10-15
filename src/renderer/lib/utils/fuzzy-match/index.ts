import uFuzzy from '@leeoniya/ufuzzy';

// One typo per word, any case, any script (uFuzzy's universal-charset options).
const finder = new uFuzzy({
  intraMode: 1,
  unicode: true,
  interSplit: "[^\\p{L}\\d']+",
  intraSplit: '\\p{Ll}\\p{Lu}',
  intraBound: '\\p{L}\\d|\\d\\p{L}|\\p{Ll}\\p{Lu}',
  intraChars: "[\\p{L}\\d']",
  intraContr: "'\\p{L}{1,2}\\b",
});

/**
 * Items whose text contains every query word, in any order, allowing one typo per word.
 * Keeps the input order. A blank query keeps everything; `-word` excludes, `"quoted"` is exact.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
): T[] {
  if (!query.trim()) return [...items];
  // outOfOrder=1 filters word by word; infoThresh=0 skips ranking.
  const [idxs] = finder.search(items.map(toText), query, 1, 0);
  if (!idxs) return [];
  const matched = new Set(idxs);
  return items.filter((_, index) => matched.has(index));
}
