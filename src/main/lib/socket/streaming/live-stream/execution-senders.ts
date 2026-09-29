import {
  sendStreamChunkDirect,
  sendExecuteCompleteDirect,
  sendErrorDirect,
  sendStreamSettledDirect,
} from '../../client';
import { armLiveStreamNotification } from './registry';

/** Read this invocation's identity at dispatch, including deferred and wake completions. */
export function createExecutionSenders(
  current: () => { streamEpoch?: string; signal?: AbortSignal; failed: boolean },
) {
  const withEpoch = <T extends { streamEpoch?: string }>(payload: T): T => {
    const { streamEpoch } = current();
    return streamEpoch ? { ...payload, streamEpoch } : payload;
  };
  return {
    chunk: (payload: Parameters<typeof sendStreamChunkDirect>[0]) =>
      sendStreamChunkDirect(withEpoch(payload)),
    complete: (payload: Parameters<typeof sendExecuteCompleteDirect>[0]) => {
      const { streamEpoch, signal, failed } = current();
      const completion = withEpoch(payload);
      if (streamEpoch)
        armLiveStreamNotification({ ...completion, streamEpoch }, failed ? undefined : signal);
      return sendExecuteCompleteDirect(completion);
    },
    error: (
      payload: Parameters<typeof sendErrorDirect>[0],
      finalization?: Parameters<typeof sendErrorDirect>[1],
    ) => {
      const runPayload = payload.assistantMessageId ? withEpoch(payload) : payload;
      return finalization
        ? sendErrorDirect(runPayload, withEpoch(finalization))
        : sendErrorDirect(runPayload);
    },
    settled: (payload: Parameters<typeof sendStreamSettledDirect>[0]) =>
      sendStreamSettledDirect(withEpoch(payload)),
  };
}
