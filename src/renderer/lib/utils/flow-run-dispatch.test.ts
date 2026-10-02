import { describe, expect, it, vi } from 'vitest';
import { batchStartedMessage, dispatchFlowRun, runStartedMessage } from './flow-run-dispatch';

function handlers() {
  return { startBatch: vi.fn(), runSingle: vi.fn() };
}

describe('dispatchFlowRun', () => {
  it('routes a current batch to startBatch (never a context-less single run)', () => {
    const h = handlers();
    dispatchFlowRun('batch-123', h);
    expect(h.startBatch).toHaveBeenCalledExactlyOnceWith('batch-123', false);
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

describe('dispatchFlowRun — unsaved canvas edits', () => {
  it('forwards the dirty flag to a single run', () => {
    const h = handlers();
    dispatchFlowRun(null, h, true);
    expect(h.runSingle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('forwards the dirty flag to a batch start', () => {
    const h = handlers();
    dispatchFlowRun('batch-1', h, true);
    expect(h.startBatch).toHaveBeenCalledExactlyOnceWith('batch-1', true);
  });

  it('defaults to a clean canvas when no flag is given', () => {
    const h = handlers();
    dispatchFlowRun(null, h);
    expect(h.runSingle).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe('batchStartedMessage', () => {
  it('keeps the plain copy for a clean editor', () => {
    expect(batchStartedMessage(false)).toBe('Batch started');
  });

  it('says the unsaved edits are not included when dirty', () => {
    expect(batchStartedMessage(true)).toBe(
      "Batch started on the saved version — your unsaved edits aren't included",
    );
  });
});

describe('runStartedMessage', () => {
  it('keeps the plain copy for a clean editor (no new friction on the common path)', () => {
    expect(
      runStartedMessage({ status: 'running', versionNumber: 5, hadUnsavedChanges: false }),
    ).toBe('Run started');
    expect(
      runStartedMessage({ status: 'pending', versionNumber: 5, hadUnsavedChanges: false }),
    ).toBe('Run queued');
  });

  it('names the executed saved version when the canvas had unsaved edits', () => {
    expect(
      runStartedMessage({ status: 'running', versionNumber: 5, hadUnsavedChanges: true }),
    ).toBe("Run started on saved v5 — your unsaved edits aren't included");
    expect(
      runStartedMessage({ status: 'pending', versionNumber: 2, hadUnsavedChanges: true }),
    ).toBe("Run queued on saved v2 — your unsaved edits aren't included");
  });

  it('still warns about unsaved edits when the version number is unknown', () => {
    expect(
      runStartedMessage({ status: 'running', versionNumber: undefined, hadUnsavedChanges: true }),
    ).toBe("Run started on the saved version — your unsaved edits aren't included");
  });
});
