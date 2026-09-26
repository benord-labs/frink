/* eslint-disable project-structure/folder-structure -- co-located test for the grandfathered
   root module task-poller.ts; relocate together when that module gets a lib domain. */
import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';


vi.mock('./db', () => ({ getDatabase: vi.fn(() => ({}) as unknown) }));

const repoMocks = vi.hoisted(() => ({
  claimTask: vi.fn(),
  getPendingTaskIds: vi.fn(),
}));

vi.mock('./db/repos/tasks', () => repoMocks);

import { TaskPoller } from './task-poller';

describe('TaskPoller', () => {
  it('starts, polls, and claims with the hostname label', async () => {
    repoMocks.getPendingTaskIds.mockResolvedValue([{ id: 't1' }]);
    repoMocks.claimTask.mockResolvedValue({ id: 't1', status: 'running' });

    const poller = new TaskPoller();
    const claimed = vi.fn();
    poller.on('task:claimed', claimed);
    try {
      await poller.start();

      expect(poller.isRunning()).toBe(true);
      expect(repoMocks.claimTask).toHaveBeenCalledWith(expect.anything(), 't1', hostname());
      expect(claimed).toHaveBeenCalledWith({ id: 't1', status: 'running' });
    } finally {
      poller.stop();
    }
  });
});
