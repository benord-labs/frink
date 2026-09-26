/**
 * Pure predicates for @-mention dropdown loading / global-search state (unit-tested).
 */

export function computeBriefingsHookLoading(o: {
  projectId: string | undefined;
  briefingsError: unknown;
  briefingsPending: boolean;
  briefingsLoading: boolean;
  briefingsFetching: boolean;
}): boolean {
  return (
    !!o.projectId &&
    !o.briefingsError &&
    (o.briefingsPending || o.briefingsLoading || o.briefingsFetching)
  );
}

export function isGlobalSearchNonFileSubpage(o: {
  debouncedSearchText: string;
  fileHeavyView: boolean;
  showingBriefingsList: boolean;
  showingSkillsList: boolean;
  showingAgentsList: boolean;
  showingToolsList: boolean;
}): boolean {
  return (
    !!o.debouncedSearchText &&
    !o.fileHeavyView &&
    !o.showingBriefingsList &&
    !o.showingSkillsList &&
    !o.showingAgentsList &&
    !o.showingToolsList
  );
}
