export type ContentSearchOptions = {
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  /** Comma-separated globs, e.g. `src, *.ts`. Absent in options saved before globs existed. */
  includeGlobs?: string;
  excludeGlobs?: string;
};

export const DEFAULT_CONTENT_SEARCH_OPTIONS: ContentSearchOptions = {
  matchCase: false,
  wholeWord: false,
  useRegex: false,
};
