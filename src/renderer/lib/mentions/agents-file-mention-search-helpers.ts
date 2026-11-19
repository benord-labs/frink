/**
 * Pure helpers for the @-mention dropdown (unit-tested): which entries match a search and in what
 * order, and its loading / global-search state.
 */

const WHITESPACE_REGEX = /\s+/;
const FILE_EXT_REGEX = /\.[^.]+$/;

export function isGlobalSearchNonFileSubpage(o: {
  debouncedSearchText: string;
  fileHeavyView: boolean;
  showingSkillsList: boolean;
  showingAgentsList: boolean;
  showingToolsList: boolean;
}): boolean {
  return (
    !!o.debouncedSearchText &&
    !o.fileHeavyView &&
    !o.showingSkillsList &&
    !o.showingAgentsList &&
    !o.showingToolsList
  );
}

/** Whether the dropdown says it found nothing: only once nothing is loading, erroring or listed. */
export function showsEmptyMentionList(o: {
  optionCount: number;
  showFullPanelLoadingFiles: boolean;
  showGlobalSearchPanelLoading: boolean;
  showFullPanelFileError: boolean;
  showingSkillsList: boolean;
  showingAgentsList: boolean;
  showingToolsList: boolean;
  fileHeavyView: boolean;
  debouncedSearchText: string;
  filesLoading: boolean;
  filesFetching: boolean;
}): boolean {
  if (
    o.optionCount > 0 ||
    o.showFullPanelLoadingFiles ||
    o.showGlobalSearchPanelLoading ||
    o.showFullPanelFileError
  ) {
    return false;
  }
  if (o.showingSkillsList || o.showingAgentsList || o.showingToolsList) return true;
  // A file view with an error already returned above, through showFullPanelFileError.
  const filesSettled = !o.filesLoading && !o.filesFetching;
  return o.fileHeavyView ? filesSettled : !!o.debouncedSearchText && filesSettled;
}

/**
 * Check if a string matches all search words (multi-word search)
 * Splits search by whitespace, all words must be present in target
 */
export function matchesMultiWordSearch(target: string, searchLower: string): boolean {
  if (!searchLower) return true;
  const searchWords = searchLower.split(WHITESPACE_REGEX).filter(Boolean);
  if (searchWords.length === 0) return true;
  const targetLower = target.toLowerCase();
  return searchWords.every((word) => targetLower.includes(word));
}

/**
 * Sort files by relevance to search query
 * Priority: exact match > starts with > shorter match > contains in filename > alphabetical
 * Supports multi-word search - splits by whitespace, all words must match
 * When search ends with space, prioritize files with hyphen/underscore (e.g. "agents " -> "agents-sidebar")
 */
export function sortFilesByRelevance<T extends { label: string; path?: string }>(
  files: T[],
  searchText: string,
): T[] {
  if (!searchText) return files;

  const searchLower = searchText.toLowerCase();
  const searchWords = searchLower.split(WHITESPACE_REGEX).filter(Boolean);
  const isSingleWord = searchWords.length <= 1;
  // Check if search ends with space - user wants to continue with hyphenated names
  const endsWithSpace = searchText.endsWith(' ');

  return [...files].sort((a, b) => {
    const aLabelLower = a.label.toLowerCase();
    const bLabelLower = b.label.toLowerCase();

    // Get filename without extension for matching
    const aNameNoExt = aLabelLower.replace(FILE_EXT_REGEX, '');
    const bNameNoExt = bLabelLower.replace(FILE_EXT_REGEX, '');

    // For multi-word search, prioritize files where all words match in filename
    if (!isSingleWord) {
      const aAllInFilename = searchWords.every((w) => aLabelLower.includes(w));
      const bAllInFilename = searchWords.every((w) => bLabelLower.includes(w));
      if (aAllInFilename && !bAllInFilename) return -1;
      if (!aAllInFilename && bAllInFilename) return 1;
    }

    // When search ends with space, prioritize files with hyphen/underscore after first word
    // e.g. "agents " should show "agents-sidebar" before "agents" folder
    if (endsWithSpace && searchWords.length >= 1) {
      const lastWord = searchWords[searchWords.length - 1];
      // Check if filename has hyphen/underscore continuation after matching word
      const aHasContinuation =
        aNameNoExt.includes(`${lastWord}-`) || aNameNoExt.includes(`${lastWord}_`);
      const bHasContinuation =
        bNameNoExt.includes(`${lastWord}-`) || bNameNoExt.includes(`${lastWord}_`);
      if (aHasContinuation && !bHasContinuation) return -1;
      if (!aHasContinuation && bHasContinuation) return 1;
    }

    // Priority 1: EXACT match (chat.tsx when searching "chat") - single word only, not when ending with space
    if (isSingleWord && !endsWithSpace) {
      const aExact = aNameNoExt === searchLower;
      const bExact = bNameNoExt === searchLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
    }

    // Priority 2: filename STARTS with first search word
    const firstWord = searchWords[0] || searchLower;
    const aStartsWith = aNameNoExt.startsWith(firstWord);
    const bStartsWith = bNameNoExt.startsWith(firstWord);
    if (aStartsWith && !bStartsWith) return -1;
    if (!aStartsWith && bStartsWith) return 1;

    // Priority 3: If both start with query, shorter name = higher match %
    // But when ending with space, prefer longer (hyphenated) names
    if (aStartsWith && bStartsWith) {
      if (aNameNoExt.length !== bNameNoExt.length) {
        if (endsWithSpace) {
          return bNameNoExt.length - aNameNoExt.length; // longer first when space at end
        }
        return aNameNoExt.length - bNameNoExt.length; // shorter first normally
      }
    }

    // Priority 4: filename CONTAINS first word (but doesn't start with it)
    const aFilenameMatch = aLabelLower.includes(firstWord);
    const bFilenameMatch = bLabelLower.includes(firstWord);
    if (aFilenameMatch && !bFilenameMatch) return -1;
    if (!aFilenameMatch && bFilenameMatch) return 1;

    // Finally: alphabetically by label
    return a.label.localeCompare(b.label);
  });
}
