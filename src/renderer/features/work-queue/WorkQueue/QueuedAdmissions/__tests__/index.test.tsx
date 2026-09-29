// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerContext } from '../../../../../../shared/types/trigger-context';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import {
  type QueuedAdmission,
  QueuedAdmissionsView,
  type QueuedAdmissionsViewProps,
} from '../../QueuedAdmissionsView';

const move = vi.fn<QueuedAdmissionsViewProps['onMove']>(async () => undefined);
const removeRow = vi.fn<QueuedAdmissionsViewProps['onRemove']>(async () => true);
const retry = vi.fn();

const shortcutTrigger: TriggerContext = {
  source: 'shortcut',
  sourceAccountId: 'acct-1',
  eventType: 'story_assigned',
  triggeredBy: {},
  timestamp: '2026-09-15T20:32:41.546Z',
  autoStart: false,
  fullContent: {
    primary_id: 3377,
    actions: [{ entity_type: 'story', name: 'Un-ignore the atoms barrel' }],
    references: [],
  },
};

const queuedRows = [
  {
    flowName: 'Resume release',
    isBatchMember: false,
    priorityClass: 'resume',
    projectName: 'Frink',
    subject: 'Un-ignore the atoms barrel',
    ticket: 1,
    triggerContext: shortcutTrigger,
  },
  {
    flowName: 'Resume docs',
    isBatchMember: false,
    priorityClass: 'resume',
    projectName: null,
    subject: null,
    ticket: 2,
    triggerContext: null,
  },
  {
    flowName: 'Start checks',
    isBatchMember: true,
    priorityClass: 'start',
    projectName: 'Frink',
    subject: '#3377 atoms/index.ts',
    ticket: 3,
    triggerContext: null,
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
    expect(
      screen.getByRole('button', { name: 'Reorder Resume release, Resuming 1 of 2' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Move Resume release up, Resuming 1 of 2' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move Resume release down, Resuming 1 of 2' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Reorder Start checks, Starting 1 of 1' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move Start checks up, Starting 1 of 1' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move Start checks down, Starting 1 of 1' }),
    ).toBeDisabled();
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
    const moveDown = screen.getByRole('button', {
      name: 'Move Resume release down, Resuming 1 of 2',
    });
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
    const { container } = renderQueue({
      announcement: 'Start checks removed from the queue.',
      rows: [],
    });

    const live = container.querySelector('p[role="status"]');
    expect(live).toHaveTextContent('Start checks removed from the queue.');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(container.firstChild).toHaveAttribute('tabindex', '-1');
  });

  it('locks every row control while a queue mutation is in flight', () => {
    renderQueue({ moving: true });

    expect(
      screen.getByRole('button', { name: 'Remove Resume release from queue, Resuming 1 of 2' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Reorder Resume release, Resuming 1 of 2' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move Resume release down, Resuming 1 of 2' }),
    ).toBeDisabled();
  });

  it('shows what each run is about, and offers the original content only where a trigger payload exists', () => {
    renderQueue();
    const rows = screen.getAllByRole('listitem');

    // Webhook start: story name in the row, eye button present under a per-row unique name.
    expect(rows[0]).toHaveTextContent('Un-ignore the atoms barrel');
    expect(rows[0]).not.toHaveTextContent('Waiting to resume');
    expect(
      screen.getByRole('button', {
        name: 'View original content for Resume release, Resuming 1 of 2',
      }),
    ).toBeEnabled();
    // Nothing readable on the run: the waiting line stays and there is nothing to open.
    expect(rows[1]).toHaveTextContent('Waiting to resume');
    // Batch member: the item label is the subject, but its blob is not a trigger payload to view.
    expect(rows[2]).toHaveTextContent('#3377 atoms/index.ts');
    expect(screen.getAllByRole('button', { name: /^View original content for / })).toHaveLength(1);
  });

  it('opens the trigger dialog from the row and returns focus to the eye button on close', async () => {
    renderQueue({ moving: true });
    const eye = screen.getByRole('button', {
      name: 'View original content for Resume release, Resuming 1 of 2',
    });
    // Read-only, so it stays usable while a queue mutation is in flight.
    expect(eye).toBeEnabled();

    fireEvent.click(eye);
    const dialog = screen.getByRole('dialog', { name: 'Original Shortcut Trigger' });
    expect(within(dialog).getByRole('tab', { name: 'Summary' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Raw payload' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: 'Un-ignore the atoms barrel' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(eye).toHaveFocus());
  });

  it('lands focus on the panel when the row left the queue while its dialog was open', async () => {
    const { container, rerender } = renderQueue();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View original content for Resume release, Resuming 1 of 2',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Original Shortcut Trigger' });

    // The 5s poll refreshed the list without that ticket: the row, and its eye button, are gone.
    rerender(
      <TooltipProvider>
        <QueuedAdmissionsView
          announcement=""
          error={false}
          loading={false}
          moving={false}
          onMove={move}
          onRemove={removeRow}
          onRetry={retry}
          rows={queuedRows.slice(1)}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Original Shortcut Trigger' })).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(container.firstChild).toHaveFocus());
  });

  it('offers a retry when queued admissions cannot be loaded', () => {
    renderQueue({ error: true, rows: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
