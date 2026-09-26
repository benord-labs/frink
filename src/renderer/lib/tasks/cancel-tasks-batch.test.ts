import { describe, expect, it, vi } from 'vitest';
import { cancelTasksBatch } from './cancel-tasks-batch';

const cancelMutateMock = vi.fn();

vi.mock('../trpc', () => ({
  trpcClient: {
    tasks: {
      cancel: {
        mutate: (...args: unknown[]) => cancelMutateMock(...args),
      },
    },
  },
}));

describe('cancelTasksBatch', () => {
  it('returns zero counts for empty input', async () => {
    cancelMutateMock.mockReset();
    const result = await cancelTasksBatch([]);
    expect(result).toEqual({ total: 0, cancelledCount: 0, failedCount: 0 });
    expect(cancelMutateMock).not.toHaveBeenCalled();
  });

  it('deduplicates task ids before canceling', async () => {
    cancelMutateMock.mockReset();
    cancelMutateMock.mockResolvedValue({ ok: true });
    const result = await cancelTasksBatch(['a', 'a', 'b']);
    expect(cancelMutateMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ total: 2, cancelledCount: 2, failedCount: 0 });
  });

  it('reports partial failures', async () => {
    cancelMutateMock.mockReset();
    cancelMutateMock
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });
    const result = await cancelTasksBatch(['a', 'b', 'c']);
    expect(result).toEqual({ total: 3, cancelledCount: 2, failedCount: 1 });
  });

  it('reports complete failure', async () => {
    cancelMutateMock.mockReset();
    cancelMutateMock.mockRejectedValue(new Error('fail'));
    const result = await cancelTasksBatch(['a', 'b']);
    expect(result).toEqual({ total: 2, cancelledCount: 0, failedCount: 2 });
  });
});
