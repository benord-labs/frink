import { describe, expect, it } from 'vitest';
import {
  assertProjectNotBeingDeleted,
  beginProjectDeletion,
  ProjectDeletionInProgressError,
} from './projects';

describe('project deletion lock', () => {
  it('stays held until every concurrent delete of the project has released it', () => {
    const releaseFirst = beginProjectDeletion('p');
    const releaseSecond = beginProjectDeletion('p');

    releaseFirst();
    releaseFirst(); // a double release must not free the second delete's hold
    expect(() => assertProjectNotBeingDeleted('p')).toThrow(ProjectDeletionInProgressError);

    releaseSecond();
    expect(() => assertProjectNotBeingDeleted('p')).not.toThrow();
  });

  it('never blocks chats that have no project', () => {
    expect(() => assertProjectNotBeingDeleted(null)).not.toThrow();
  });
});
