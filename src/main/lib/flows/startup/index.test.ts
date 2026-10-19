import { afterEach, describe, expect, it, vi } from 'vitest';
import * as batchDispatch from '../batch-dispatch';
import * as usageTelemetry from '../usage-telemetry';
import { startRunTerminalListeners } from './index';

const unsubscribe = () => undefined;

describe('startRunTerminalListeners', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts both run-terminal listeners at boot', async () => {
    const batch = vi.spyOn(batchDispatch, 'startBatchAdvanceListener').mockReturnValue(unsubscribe);
    const usage = vi.spyOn(usageTelemetry, 'startFlowRunTelemetry').mockReturnValue(unsubscribe);

    await startRunTerminalListeners();

    expect(batch).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
  });

  it('still counts runs when the batch listener fails to start', async () => {
    vi.spyOn(batchDispatch, 'startBatchAdvanceListener').mockImplementation(() => {
      throw new Error('batch listener failed');
    });
    const usage = vi.spyOn(usageTelemetry, 'startFlowRunTelemetry').mockReturnValue(unsubscribe);

    await startRunTerminalListeners();

    expect(usage).toHaveBeenCalledOnce();
  });
});
