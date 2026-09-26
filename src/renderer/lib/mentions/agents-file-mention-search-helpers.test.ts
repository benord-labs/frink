import { describe, expect, it } from 'vitest';
import {
  computeBriefingsHookLoading,
  isGlobalSearchNonFileSubpage,
} from '@/lib/mentions/agents-file-mention-search-helpers';

describe('computeBriefingsHookLoading', () => {
  const base = {
    projectId: 'p1' as string | undefined,
    briefingsError: null as unknown,
    briefingsPending: false,
    briefingsLoading: false,
    briefingsFetching: false,
  };

  it('is false without projectId', () => {
    expect(
      computeBriefingsHookLoading({ ...base, projectId: undefined, briefingsPending: true }),
    ).toBe(false);
  });

  it('is false when briefingsError is set', () => {
    expect(
      computeBriefingsHookLoading({
        ...base,
        briefingsError: new Error('x'),
        briefingsPending: true,
      }),
    ).toBe(false);
  });

  it('is true when projectId set, no error, and any of pending/loading/fetching', () => {
    expect(computeBriefingsHookLoading({ ...base, briefingsPending: true })).toBe(true);
    expect(computeBriefingsHookLoading({ ...base, briefingsLoading: true })).toBe(true);
    expect(computeBriefingsHookLoading({ ...base, briefingsFetching: true })).toBe(true);
  });

  it('is false when idle with no error', () => {
    expect(computeBriefingsHookLoading(base)).toBe(false);
  });
});

describe('isGlobalSearchNonFileSubpage', () => {
  const rootSearch = {
    debouncedSearchText: 'q',
    fileHeavyView: false,
    showingBriefingsList: false,
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
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingBriefingsList: true })).toBe(false);
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingSkillsList: true })).toBe(false);
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingAgentsList: true })).toBe(false);
    expect(isGlobalSearchNonFileSubpage({ ...rootSearch, showingToolsList: true })).toBe(false);
  });
});
