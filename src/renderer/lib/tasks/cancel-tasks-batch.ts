import { trpcClient } from '../trpc';

type CancelTasksBatchResult = {
  total: number;
  cancelledCount: number;
  failedCount: number;
};

const CANCEL_TASKS_CONCURRENCY = 10;

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export async function cancelTasksBatch(taskIds: string[]): Promise<CancelTasksBatchResult> {
  const uniqueTaskIds = Array.from(new Set(taskIds));
  if (uniqueTaskIds.length === 0) {
    return { total: 0, cancelledCount: 0, failedCount: 0 };
  }

  const results: PromiseSettledResult<unknown>[] = [];
  for (const idsChunk of chunkIds(uniqueTaskIds, CANCEL_TASKS_CONCURRENCY)) {
    const chunkResults = await Promise.allSettled(
      idsChunk.map((taskId) => trpcClient.tasks.cancel.mutate(taskId)),
    );
    results.push(...chunkResults);
  }

  const failedCount = results.filter((result) => result.status === 'rejected').length;
  return {
    total: uniqueTaskIds.length,
    cancelledCount: uniqueTaskIds.length - failedCount,
    failedCount,
  };
}
