/**
 * Pure predicates for @-mention dropdown loading / global-search state (unit-tested).
 */

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
