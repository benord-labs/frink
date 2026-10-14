// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkQueueOverviewCounts } from './index';

const { admissionsUseQueryMock, approvalsUseQueryMock, overviewUseQueryMock } = vi.hoisted(() => ({
  admissionsUseQueryMock: vi.fn(),
  approvalsUseQueryMock: vi.fn(),
  overviewUseQueryMock: vi.fn(),
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    tasks: {
      workQueueOverviewCounts: { useQuery: overviewUseQueryMock },
    },
    flows: {
      workQueueAdmissions: { useQuery: admissionsUseQueryMock },
      workQueueApprovals: { useQuery: approvalsUseQueryMock },
    },
  },
}));

describe('useWorkQueueOverviewCounts', () => {
  beforeEach(() => {
    admissionsUseQueryMock.mockReset();
    overviewUseQueryMock.mockReset();
    approvalsUseQueryMock.mockReturnValue({ data: undefined });
  });

  it('uses the visible admissions as the queued count', () => {
    overviewUseQueryMock.mockReturnValue({
      data: { inbox: 3, queued: 12, review: 9, running: 4 },
      isLoading: false,
    });
    admissionsUseQueryMock.mockReturnValue({ data: [{ ticket: 1 }], isLoading: false });

    const { result } = renderHook(() =>
      useWorkQueueOverviewCounts({ inbox: 0, queued: 0, review: 1, running: 0 }),
    );

    expect(result.current).toEqual({ inbox: 3, queued: 1, review: 9, running: 4 });
    expect(overviewUseQueryMock).toHaveBeenCalledWith(undefined, {
      refetchInterval: 5000,
      structuralSharing: true,
    });
    expect(admissionsUseQueryMock).toHaveBeenCalledWith(undefined, {
      refetchInterval: 5000,
      refetchOnWindowFocus: true,
      structuralSharing: true,
    });
  });

  it('keeps the overview fallback while admissions are loading', () => {
    overviewUseQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    admissionsUseQueryMock.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() =>
      useWorkQueueOverviewCounts({ inbox: 4, queued: 3, review: 2, running: 1 }),
    );

    expect(result.current).toEqual({ inbox: 4, queued: 3, review: 2, running: 1 });
  });

  it('counts each run waiting on an approval as review work', () => {
    overviewUseQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    admissionsUseQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    approvalsUseQueryMock.mockReturnValue({
      data: [{ flowRunId: 'run-1' }, { flowRunId: 'run-2' }],
    });

    const { result } = renderHook(() =>
      useWorkQueueOverviewCounts({ inbox: 0, queued: 0, review: 1, running: 0 }),
    );

    expect(result.current.review).toBe(3);
  });
});
