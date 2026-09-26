import { describe, expect, it, vi } from 'vitest';
import { createTaskExecutionErrorSignal } from './task-execution-error-signal';

describe('createTaskExecutionErrorSignal', () => {
  it('creates signal with default UNKNOWN category and timestamp', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456789);
    const signal = createTaskExecutionErrorSignal('execution failed');

    expect(signal).toEqual({
      error: 'execution failed',
      category: 'UNKNOWN',
      timestamp: 123456789,
    });

    nowSpy.mockRestore();
  });

  it('uses provided category when supplied', () => {
    const signal = createTaskExecutionErrorSignal('network timeout', 'NETWORK_ERROR');
    expect(signal.error).toBe('network timeout');
    expect(signal.category).toBe('NETWORK_ERROR');
    expect(typeof signal.timestamp).toBe('number');
  });
});

const storeMocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../../../../lib/jotai-store', () => ({ appStore: storeMocks }));
vi.mock('../../../atoms', () => ({
  taskExecutionErrorAtomFamily: (subChatId: string) => `atom:${subChatId}`,
}));

describe('clearFlowRunEndedErrorSignal', () => {
  it('clears both flow-run decline categories and nothing else', async () => {
    const { clearFlowRunEndedErrorSignal } = await import('./task-execution-error-signal');

    for (const category of ['FLOW_RUN_ENDED', 'FLOW_RUN_RESUMING']) {
      storeMocks.set.mockClear();
      storeMocks.get.mockReturnValue(createTaskExecutionErrorSignal('declined', category));
      clearFlowRunEndedErrorSignal('sub-1');
      expect(storeMocks.set).toHaveBeenCalledWith('atom:sub-1', null);
    }

    // An unrelated latched failure must survive recovery actions.
    storeMocks.set.mockClear();
    storeMocks.get.mockReturnValue(createTaskExecutionErrorSignal('offline', 'NETWORK_ERROR'));
    clearFlowRunEndedErrorSignal('sub-1');
    expect(storeMocks.set).not.toHaveBeenCalled();
  });
});
