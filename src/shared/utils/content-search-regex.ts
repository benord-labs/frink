/** The pattern a regular-expression content search runs for `query`; whole words only adds word boundaries. */
export function contentSearchRegexSource(query: string, wholeWord: boolean): string {
  return wholeWord ? `\\b(?:${query})\\b` : query;
}

/** Whether a regular-expression content search for `query` can't run, because its pattern isn't valid. */
export function isInvalidContentSearchRegex(query: string, wholeWord: boolean): boolean {
  try {
    new RegExp(contentSearchRegexSource(query, wholeWord));
    return false;
  } catch {
    return true;
  }
}
