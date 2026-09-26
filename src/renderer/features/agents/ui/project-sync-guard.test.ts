import { describe, expect, it } from 'vitest';
import { shouldSkipSelectedProjectSync } from './project-sync-guard';

describe('shouldSkipSelectedProjectSync', () => {
  it('skips sync when project id is unchanged and no force flag is set', () => {
    expect(
      shouldSkipSelectedProjectSync({
        lastSyncedProjectId: 'project-1',
        nextProjectId: 'project-1',
        forceResync: false,
      }),
    ).toBe(true);
  });

  it('does not skip sync after split exit when force flag is set', () => {
    expect(
      shouldSkipSelectedProjectSync({
        lastSyncedProjectId: 'project-1',
        nextProjectId: 'project-1',
        forceResync: true,
      }),
    ).toBe(false);
  });

  it('does not skip sync when project id changed', () => {
    expect(
      shouldSkipSelectedProjectSync({
        lastSyncedProjectId: 'project-1',
        nextProjectId: 'project-2',
        forceResync: false,
      }),
    ).toBe(false);
  });

  it('skips sync when both project ids are null', () => {
    expect(
      shouldSkipSelectedProjectSync({
        lastSyncedProjectId: null,
        nextProjectId: null,
        forceResync: false,
      }),
    ).toBe(true);
  });

  it('does not skip sync on null -> non-null transition', () => {
    expect(
      shouldSkipSelectedProjectSync({
        lastSyncedProjectId: null,
        nextProjectId: 'project-1',
        forceResync: false,
      }),
    ).toBe(false);
  });
});
