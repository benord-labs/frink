// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import {
  type QueuedAdmission,
  QueuedAdmissionsView,
  type QueuedAdmissionsViewProps,
} from '../../QueuedAdmissionsView';

const move = vi.fn<QueuedAdmissionsViewProps['onMove']>(async () => undefined);
const removeRow = vi.fn<QueuedAdmissionsViewProps['onRemove']>(async () => true);
const retry = vi.fn();

const queuedRows = [
  {
    flowName: 'Resume release',
    isBatchMember: false,
    priorityClass: 'resume',
    projectName: 'Frink',
    ticket: 1,
  },
  {
    flowName: 'Resume docs',
    isBatchMember: false,
    priorityClass: 'resume',
    projectName: null,
    ticket: 2,
  },
  {
    flowName: 'Start checks',
    isBatchMember: true,
    priorityClass: 'start',
    projectName: 'Frink',
    ticket: 3,
  },
] satisfies QueuedAdmission[];

function renderQueue(props: Partial<ComponentProps<typeof QueuedAdmissionsView>> = {}) {
  return render(
    <TooltipProvider>
      <QueuedAdmissionsView
        announcement=""
        error={false}
        loading={false}
        moving={false}
        onMove={move}
        onRemove={removeRow}
        onRetry={retry}
        rows={queuedRows}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe('QueuedAdmissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('separates resume and start priority while exposing pointer and keyboard controls', () => {
    renderQueue();

    const section = screen.getByRole('region', { name: 'Queued to run' });
    expect(within(section).getByRole('heading', { name: 'Resuming' })).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Starting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reorder Resume release, Resuming 1 of 2' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Resume release up, Resuming 1 of 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Resume release down, Resuming 1 of 2' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reorder Start checks, Starting 1 of 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Start checks up, Starting 1 of 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Start checks down, Starting 1 of 1' })).toBeDisabled();
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining('Resume release'),
      expect.stringContaining('Resume docs'),
      expect.stringContaining('Start checks'),
    ]);
  });

  it('requests an arrow move and keeps focus', async () => {
    renderQueue();
    const moveDown = screen.getByRole('button', { name: 'Move Resume release down, Resuming 1 of 2' });
    moveDown.focus();

    fireEvent.click(moveDown);

    await waitFor(() => expect(move).toHaveBeenCalledWith(1, 2, 1));
    expect(moveDown).toHaveFocus();
  });

  it('offers removal on every row, under a name no other row shares', () => {
    renderQueue();

    // Two rows here name the same flow group; the position + group qualifier is what keeps each
    // button individually addressable, to a screen reader and to a test alike.
    const removeButtons = screen.getAllByRole('button', { name: /^Remove .* from queue, / });
    expect(removeButtons).toHaveLength(queuedRows.length);
    expect(new Set(removeButtons.map((b) => b.getAttribute('aria-label')))).toHaveProperty(
      'size',
      queuedRows.length,
    );
    for (const button of removeButtons) expect(button).toBeEnabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Start checks from queue, Starting 1 of 1' }),
    );
    // Opening the dialog must not remove anything on its own.
    expect(removeRow).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('removes only after the dialog is confirmed, and states the batch consequence', async () => {
    const { container } = renderQueue();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Start checks from queue, Starting 1 of 1' }),
    );
    expect(screen.getByText('Remove "Start checks" from the queue?')).toBeInTheDocument();
    // Start checks is a batch member, so the copy has to name what else the removal takes down.
    expect(screen.getByText(/one failed member of its batch stage/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removeRow).toHaveBeenCalledExactlyOnceWith(queuedRows[2]));
    // The row that held focus is going away, so focus lands on the panel wrapper instead of <body>.
    await waitFor(() => expect(container.firstChild).toHaveFocus());
  });

  it('leaves focus alone when the dialog is dismissed, or the removal did not happen', async () => {
    removeRow.mockResolvedValueOnce(false);
    const { container } = renderQueue();
    const trigger = screen.getByRole('button', {
      name: 'Remove Resume release from queue, Resuming 1 of 2',
    });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeRow).not.toHaveBeenCalled();
    expect(container.firstChild).not.toHaveFocus();

    // A removal the server declined keeps its row, so pulling focus would strand a keyboard user.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeRow).toHaveBeenCalledOnce());
    expect(container.firstChild).not.toHaveFocus();
  });

  it('keeps the announcement readable after the last row leaves', () => {
    // The live region sits outside the list, which renders nothing once the queue empties.
    const { container } = renderQueue({ announcement: 'Start checks removed from the queue.', rows: [] });

    const live = container.querySelector('p[role="status"]');
    expect(live).toHaveTextContent('Start checks removed from the queue.');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(container.firstChild).toHaveAttribute('tabindex', '-1');
  });

  it('locks every row control while a queue mutation is in flight', () => {
    renderQueue({ moving: true });

    expect(screen.getByRole('button', { name: 'Remove Resume release from queue, Resuming 1 of 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reorder Resume release, Resuming 1 of 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Resume release down, Resuming 1 of 2' })).toBeDisabled();
  });

  it('offers a retry when queued admissions cannot be loaded', () => {
    renderQueue({ error: true, rows: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
