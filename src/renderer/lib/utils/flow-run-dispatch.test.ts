import { describe, expect, it, vi } from 'vitest';
import { dispatchFlowRun } from './flow-run-dispatch';

function handlers() {
  return { startBatch: vi.fn(), runSingle: vi.fn() };
}

describe('dispatchFlowRun', () => {
  it('routes a current batch to startBatch (never a context-less single run)', () => {
    const h = handlers();
    dispatchFlowRun('batch-123', h);
    expect(h.startBatch).toHaveBeenCalledExactlyOnceWith('batch-123');
    expect(h.runSingle).not.toHaveBeenCalled();
  });

  it('routes a non-batch flow (null) to a single run', () => {
    const h = handlers();
    dispatchFlowRun(null, h);
    expect(h.runSingle).toHaveBeenCalledOnce();
    expect(h.startBatch).not.toHaveBeenCalled();
  });

  it('treats an empty-string batch id as no batch — single run, not startBatch("")', () => {
    const h = handlers();
    dispatchFlowRun('', h);
    expect(h.runSingle).toHaveBeenCalledOnce();
    expect(h.startBatch).not.toHaveBeenCalled();
  });

  it('treats undefined as no batch — single run', () => {
    const h = handlers();
    dispatchFlowRun(undefined, h);
    expect(h.runSingle).toHaveBeenCalledOnce();
    expect(h.startBatch).not.toHaveBeenCalled();
  });
});
