import { describe, expect, it } from 'vitest';
import {
  isGlobalSearchNonFileSubpage,
  matchesMultiWordSearch,
  showsEmptyMentionList,
  sortFilesByRelevance,
} from '@/lib/mentions/agents-file-mention-search-helpers';

describe('isGlobalSearchNonFileSubpage', () => {
  const rootSearch = {
    debouncedSearchText: 'q',
    fileHeavyView: false,
    showingSkillsList: false,
    showingAgentsList: false,
    showingToolsList: false,
  };

  it('is true for root global search', () => {
    expect(isGlobalSearchNonFileSubpage(rootSearch)).toBe(true);
  });

  it('is false when no search text', () => {
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, debouncedSearchText: '' })).toBe(false);
  });

  it('is false on file-heavy or subpages', () => {
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, fileHeavyView: true })).toBe(false);
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingSkillsList: true })).toBe(false);
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingAgentsList: true })).toBe(false);
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingToolsList: true })).toBe(false);
  });
});

describe('showsEmptyMentionList', () => {
  const settledRoot = {
    optionCount: 0,
    showFullPanelLoadingFiles: false,
    showGlobalSearchPanelLoading: false,
    showFullPanelFileError: false,
    showingSkillsList: false,
    showingAgentsList: false,
    showingToolsList: false,
    fileHeavyView: false,
    debouncedSearchText: '',
    filesLoading: false,
    filesFetching: false,
  };

  it('is false while anything is listed, loading or showing an error', () => {
    expect(showsEmptyMentionList({ ...settledRoot, optionCount: 1, showingSkillsList: true })).toBe(
      false,
    );
    expect(
      showsEmptyMentionList({
        ...settledRoot,
        fileHeavyView: true,
        showFullPanelLoadingFiles: true,
      }),
    ).toBe(false);
    expect(
      showsEmptyMentionList({
        ...settledRoot,
        debouncedSearchText: 'q',
        showGlobalSearchPanelLoading: true,
      }),
    ).toBe(false);
    expect(
      showsEmptyMentionList({ ...settledRoot, fileHeavyView: true, showFullPanelFileError: true }),
    ).toBe(false);
  });

  it('is true for an empty skills, agents or tools list', () => {
    for (const subpage of ['showingSkillsList', 'showingAgentsList', 'showingToolsList'] as const) {
      expect(showsEmptyMentionList({ ...settledRoot, [subpage]: true })).toBe(true);
    }
  });

  it('waits for the file search to settle in a file view and in a root search', () => {
    expect(showsEmptyMentionList({ ...settledRoot, fileHeavyView: true })).toBe(true);
    expect(
      showsEmptyMentionList({ ...settledRoot, fileHeavyView: true, filesFetching: true }),
    ).toBe(false);
    expect(showsEmptyMentionList({ ...settledRoot, debouncedSearchText: 'q' })).toBe(true);
    expect(
      showsEmptyMentionList({ ...settledRoot, debouncedSearchText: 'q', filesLoading: true }),
    ).toBe(false);
  });

  it('is false on the root view with nothing typed', () => {
    expect(showsEmptyMentionList(settledRoot)).toBe(false);
  });
});

describe('matchesMultiWordSearch', () => {
  it('needs every word, in any order and case', () => {
    expect(matchesMultiWordSearch('src/Agents/sidebar.tsx', 'sidebar agents')).toBe(true);
    expect(matchesMultiWordSearch('src/agents/sidebar.tsx', 'sidebar chat')).toBe(false);
    expect(matchesMultiWordSearch('anything', '')).toBe(true);
  });
});

describe('sortFilesByRelevance', () => {
  const files = (...labels: string[]) => labels.map((label) => ({ label }));

  it('puts an exact name first, then names that start with the search, shortest first', () => {
    const sorted = sortFilesByRelevance(files('my-chat.ts', 'chat-list.ts', 'chat.tsx'), 'chat');
    expect(sorted.map((file) => file.label)).toEqual(['chat.tsx', 'chat-list.ts', 'my-chat.ts']);
  });

  it('puts hyphenated names first when the search ends with a space', () => {
    const sorted = sortFilesByRelevance(files('agents', 'agents-sidebar.tsx'), 'agents ');
    expect(sorted.map((file) => file.label)).toEqual(['agents-sidebar.tsx', 'agents']);
  });
});
