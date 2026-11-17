// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchRunState } from '../../../../lib/utils/batch-run-state';
import { UNSAVED_RUN_TITLE } from '../../../../lib/utils/flow-run-dispatch';
import { FlowRunButton } from './index';

afterEach(cleanup);

const FAILED_STATE: BatchRunState = {
  primary: 'unavailable',
  counts: { total: 3, failed: 2, completed: 1, active: 0 },
};

function renderButton(over: Partial<Parameters<typeof FlowRunButton>[0]> = {}) {
  const onPrimaryStart = vi.fn();
  render(
    <FlowRunButton
      runState={FAILED_STATE}
      isBatchDeferred={false}
      disabled={false}
      isPending={false}
      onPrimaryStart={onPrimaryStart}
      {...over}
    />,
  );
  return { onPrimaryStart };
}

describe('FlowRunButton', () => {
  it('a terminal batch shows a disabled recovery notice', () => {
    renderButton();
    expect(screen.getByRole('button', { name: 'Batch already ran' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /more options/i })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('there is no whole-batch recovery');
  });

  it('no batch → a plain "Run" button wired to onPrimaryStart', () => {
    const { onPrimaryStart } = renderButton({ runState: null });
    fireEvent.click(screen.getByText('Run'));
    expect(onPrimaryStart).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /more options/i })).not.toBeInTheDocument();
  });

  it('a running batch is disabled and announces its state', () => {
    renderButton({
      runState: { primary: 'running', counts: FAILED_STATE.counts },
    });
    expect(screen.getByText('Running…')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Batch is running');
  });

  const START_STATE: BatchRunState = {
    primary: 'start',
    counts: { total: 2, failed: 0, completed: 0, active: 0 },
  };

  it('a never-run batch with deferred roots shows "Start Batch"', () => {
    const { onPrimaryStart } = renderButton({ runState: START_STATE, isBatchDeferred: true });
    fireEvent.click(screen.getByText('Start Batch'));
    expect(onPrimaryStart).toHaveBeenCalledOnce();
  });

  it('a never-run batch with non-deferred roots shows "Run batch"', () => {
    renderButton({ runState: START_STATE, isBatchDeferred: false });
    expect(screen.getByText('Run batch')).toBeInTheDocument();
  });

  it('a pending mutation disables the button (in-flight)', () => {
    renderButton({ runState: START_STATE, isPending: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('unsaved canvas edits: plain Run says it runs the last saved version', () => {
    renderButton({ runState: null, hasUnsavedChanges: true });
    expect(screen.getByRole('button', { name: 'Run' })).toHaveAttribute('title', UNSAVED_RUN_TITLE);
  });

  it('a clean canvas adds no tooltip to the plain Run button', () => {
    renderButton({ runState: null });
    expect(screen.getByRole('button', { name: 'Run' })).not.toHaveAttribute('title');
  });

  it('a batch state title still wins over the unsaved-edits notice', () => {
    renderButton({ hasUnsavedChanges: true });
    expect(screen.getByRole('button', { name: 'Batch already ran' })).toHaveAttribute(
      'title',
      'This batch already has runs — use Continue or Retry above, per run',
    );
  });
});
