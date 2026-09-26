// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkQueueOverviewCounts } from './index';

const { admissionsUseQueryMock, overviewUseQueryMock } = vi.hoisted(() => ({
  admissionsUseQueryMock: vi.fn(),
  overviewUseQueryMock: vi.fn(),
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    tasks: {
      workQueueOverviewCounts: { useQuery: overviewUseQueryMock },
    },
    flows: {
      workQueueAdmissions: { useQuery: admissionsUseQueryMock },
    },
  },
}));

describe('useWorkQueueOverviewCounts', () => {
  beforeEach(() => {
    admissionsUseQueryMock.mockReset();
    overviewUseQueryMock.mockReset();
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
});
