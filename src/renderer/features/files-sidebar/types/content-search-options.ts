export type ContentSearchOptions = {
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
};

export const DEFAULT_CONTENT_SEARCH_OPTIONS: ContentSearchOptions = {
  matchCase: false,
  wholeWord: false,
  useRegex: false,
};
