// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHistoryRefetchInterval, useWorkQueueView, type WorkQueueViewMode } from '.';

function Harness({ onRequestClose = vi.fn() }: { onRequestClose?: () => void }) {
  const view = useWorkQueueView(onRequestClose);
  return view.isHistoryView ? (
    <>
      <span>History view</span>
      <output aria-label="Polling intervals">{String(view.historyRefetchInterval)}</output>
      <button ref={view.backToOverviewButtonRef} type="button" onClick={view.returnToOverview}>
        Back to overview
      </button>
    </>
  ) : (
    <button ref={view.historyButtonRef} type="button" onClick={view.openHistory}>
      View task history
    </button>
  );
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('useWorkQueueView', () => {
  it('opens a distinct History view and restores focus to its footer action', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'View task history' }));
    expect(screen.getByText('History view')).toBeInTheDocument();
    expect(screen.getByLabelText('Polling intervals')).toHaveTextContent('5000');
    expect(screen.getByRole('button', { name: 'Back to overview' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    expect(screen.getByRole('button', { name: 'View task history' })).toHaveFocus();
  });

  it('uses an unclaimed Escape to leave History before closing the Work Queue', () => {
    const onRequestClose = vi.fn();
    render(<Harness onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'View task history' }));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'View task history' })).toHaveFocus();
    expect(onRequestClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('keeps History open while a dialog layer owns Escape', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'View task history' }));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Back to overview' })).toBeInTheDocument();
  });
});

it.each([
  { view: 'overview', expected: false },
  { view: 'history', expected: 5000 },
] as const)('polls History rows only in $view', (scenario) => {
  expect(getHistoryRefetchInterval(scenario.view as WorkQueueViewMode)).toBe(scenario.expected);
});
