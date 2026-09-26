import { describe, expect, it, vi } from 'vitest';
import { getTaskRefetchInterval, invalidateTaskQueries } from './task-query';

describe('task query helpers', () => {
  it('stops polling for terminal task statuses', () => {
    expect(getTaskRefetchInterval('completed')).toBe(false);
    expect(getTaskRefetchInterval('cancelled')).toBe(false);
    expect(getTaskRefetchInterval('failed')).toBe(false);
    expect(getTaskRefetchInterval('needs_attention')).toBe(false);
    expect(getTaskRefetchInterval('done')).toBe(false);
    expect(getTaskRefetchInterval('pending')).toBe(5000);
    expect(getTaskRefetchInterval('plan_ready')).toBe(10000);
    expect(getTaskRefetchInterval('running')).toBe(5000);
    expect(getTaskRefetchInterval(undefined)).toBe(false);
  });

  it('invalidates every task query, including the driving-task query the parked-question card reads', () => {
    const listPaginatedInvalidate = vi.fn();
    const listCountsInvalidate = vi.fn();
    const byIdInvalidate = vi.fn();
    const drivingTaskInvalidate = vi.fn();
    const actionableTaskInvalidate = vi.fn();
    invalidateTaskQueries({
      tasks: {
        listPaginated: { invalidate: listPaginatedInvalidate },
        listCounts: { invalidate: listCountsInvalidate },
        getById: { invalidate: byIdInvalidate },
        getDrivingTaskForSubChat: { invalidate: drivingTaskInvalidate },
        getActionableTaskForSubChat: { invalidate: actionableTaskInvalidate },
      },
    });
    expect(listPaginatedInvalidate).toHaveBeenCalledTimes(1);
    expect(listCountsInvalidate).toHaveBeenCalledTimes(1);
    expect(byIdInvalidate).toHaveBeenCalledTimes(1);
    expect(drivingTaskInvalidate).toHaveBeenCalledTimes(1);
    expect(actionableTaskInvalidate).toHaveBeenCalledTimes(1);
  });
});
