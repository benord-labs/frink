// @vitest-environment happy-dom
/**
 * UI tests for the queue indicator's edit affordance and editing-row visuals.
 * DnD interactions (pointer move + reorder) are not exercised here — they're flaky in
 * happy-dom; the reorder contract is a one-line callback and is covered indirectly by the
 * store-level reorderQueue tests.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentQueueItem } from '../lib/queue-utils';
import { AgentQueueIndicator } from './agent-queue-indicator';

vi.mock('../mentions/render-file-mentions', () => ({
  RenderFileMentions: ({ text }: { text: string }) => <span>{text}</span>,
}));

// The real tooltip uses Radix and requires a TooltipProvider higher in the tree. We're not
// testing tooltip rendering — we're testing button behaviour — so render only the trigger's
// children and drop the TooltipContent text (which would otherwise sit in the DOM and
// duplicate accessible-name matches like "Send now").
vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: () => null,
}));

vi.mock('../commands/parse-slash-command-display', () => ({
  parseSlashCommandDisplayParts: (msg: string) => ({
    commandName: null,
    commandText: null,
    cleanedText: msg,
  }),
}));

const baseItem: AgentQueueItem = {
  id: 'q1',
  message: 'first message',
  timestamp: new Date('2026-01-01T00:00:00Z'),
  status: 'pending',
};

afterEach(() => {
  cleanup();
});

describe('AgentQueueIndicator — edit affordance', () => {
  it('renders the pencil button when onEditItem is provided', () => {
    render(<AgentQueueIndicator queue={[baseItem]} onEditItem={vi.fn()} inputHasContent={false} />);
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
  });

  it('does NOT render the pencil button when onEditItem is omitted', () => {
    render(<AgentQueueIndicator queue={[baseItem]} inputHasContent={false} />);
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('disables the pencil and shows the "Clear input to edit" tooltip when inputHasContent is true', () => {
    render(<AgentQueueIndicator queue={[baseItem]} onEditItem={vi.fn()} inputHasContent={true} />);
    const btn = screen.getByRole('button', { name: /clear input to edit/i });
    expect(btn).toBeDisabled();
  });

  it('fires onEditItem with the item id when the pencil is clicked', () => {
    const onEdit = vi.fn();
    render(<AgentQueueIndicator queue={[baseItem]} onEditItem={onEdit} inputHasContent={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith('q1');
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  // The action's VERB depends on whether it can actually steer. Naming it "Steer" while the agent
  // is idle (or on a runtime with no live input channel) would promise a delivery that cannot
  // happen, so it falls back to the honest "Send now".
  it('names the action Steer only while streaming on a steer-capable runtime', () => {
    render(
      <AgentQueueIndicator
        queue={[baseItem]}
        onSendNow={vi.fn()}
        inputHasContent={false}
        isStreaming
      />,
    );
    expect(screen.getByRole('button', { name: 'Steer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
  });

  it('keeps "Send now" when the agent is idle — there is no turn to steer into', () => {
    render(<AgentQueueIndicator queue={[baseItem]} onSendNow={vi.fn()} inputHasContent={false} />);
    expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
  });

  it('keeps "Send now" on a runtime with no steer channel, even while streaming', () => {
    render(
      <AgentQueueIndicator
        queue={[baseItem]}
        onSendNow={vi.fn()}
        inputHasContent={false}
        isStreaming
        steerSupported={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
  });

  it('does NOT fire onEditItem when the pencil is clicked while disabled (inputHasContent)', () => {
    const onEdit = vi.fn();
    render(<AgentQueueIndicator queue={[baseItem]} onEditItem={onEdit} inputHasContent={true} />);
    fireEvent.click(screen.getByRole('button', { name: /clear input to edit/i }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('does NOT fire onEditItem on the row currently being edited (pencil locked)', () => {
    const onEdit = vi.fn();
    render(
      <AgentQueueIndicator
        queue={[baseItem]}
        onEditItem={onEdit}
        inputHasContent={false}
        editingItemId="q1"
      />,
    );
    // The pencil tooltip becomes "Editing — send to apply" and the button is disabled.
    const btn = screen.getByRole('button', { name: /editing.*send to apply/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('AgentQueueIndicator — editing row visuals', () => {
  it('shows the "Editing…" badge on the matching row only', () => {
    const items: AgentQueueItem[] = [
      { ...baseItem, id: 'q1', message: 'editing me' },
      { ...baseItem, id: 'q2', message: 'other' },
    ];
    render(
      <AgentQueueIndicator
        queue={items}
        onEditItem={vi.fn()}
        inputHasContent={false}
        editingItemId="q1"
      />,
    );
    const badges = screen.getAllByText(/^editing$/i);
    // Exactly one editing badge — only on the matching row.
    expect(badges).toHaveLength(1);
  });

  it('announces the editing badge to assistive tech (role=status, aria-live=polite)', () => {
    // The editing row is visually distinguished, but a screen-reader user has no equivalent
    // signal unless the badge is announced. role="status" + aria-live="polite" makes the
    // transition into edit mode polite-announced without interrupting other speech.
    render(
      <AgentQueueIndicator
        queue={[baseItem]}
        onEditItem={vi.fn()}
        inputHasContent={false}
        editingItemId="q1"
      />,
    );
    const badge = screen.getByText(/^editing$/i);
    expect(badge).toHaveAttribute('role', 'status');
    expect(badge).toHaveAttribute('aria-live', 'polite');
  });

  it('hides the "Send now" arrow on the editing row (sending mid-edit would be confusing)', () => {
    const items: AgentQueueItem[] = [
      { ...baseItem, id: 'q1', message: 'editing me' },
      { ...baseItem, id: 'q2', message: 'other' },
    ];
    const { container } = render(
      <AgentQueueIndicator
        queue={items}
        onSendNow={vi.fn()}
        onEditItem={vi.fn()}
        inputHasContent={false}
        editingItemId="q1"
      />,
    );
    // The non-editing row keeps its send-now button; the editing row drops it.
    const sendNowButtons = container.querySelectorAll('button[aria-label="Send now"]');
    expect(sendNowButtons.length).toBe(1);
  });
});

describe('AgentQueueIndicator — button event isolation', () => {
  it('clicking Send now fires only onSendNow (not onRemove or onEdit)', () => {
    const onSend = vi.fn();
    const onRemove = vi.fn();
    const onEdit = vi.fn();
    render(
      <AgentQueueIndicator
        queue={[baseItem]}
        onSendNow={onSend}
        onRemoveItem={onRemove}
        onEditItem={onEdit}
        inputHasContent={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /send now/i }));
    expect(onSend).toHaveBeenCalledWith('q1', false);
    expect(onRemove).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('clicking Remove fires only onRemoveItem (not onSendNow or onEdit)', () => {
    const onSend = vi.fn();
    const onRemove = vi.fn();
    const onEdit = vi.fn();
    render(
      <AgentQueueIndicator
        queue={[baseItem]}
        onSendNow={onSend}
        onRemoveItem={onRemove}
        onEditItem={onEdit}
        inputHasContent={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove from queue/i }));
    expect(onRemove).toHaveBeenCalledWith('q1');
    expect(onSend).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('AgentQueueIndicator — empty state', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<AgentQueueIndicator queue={[]} inputHasContent={false} />);
    expect(container.firstChild).toBeNull();
  });
});

// The marker squares the top of the composer-slot surface below (globals.css), and the top card
// takes that surface's 1rem radius, so the stack reads as one object.
describe('AgentQueueIndicator — stacked on the composer slot', () => {
  it('marks itself as a stacked card and rounds its top like the slot surface', () => {
    const { container } = render(
      <AgentQueueIndicator queue={[baseItem]} inputHasContent={false} />,
    );
    expect(container.firstChild).toHaveAttribute('data-stacked-card');
    expect(container.firstChild).toHaveClass('rounded-t-2xl', 'border-b-0');
  });
});

describe('AgentQueueIndicator — header count', () => {
  it('shows the correct in-queue count', () => {
    const items: AgentQueueItem[] = [
      { ...baseItem, id: 'a' },
      { ...baseItem, id: 'b' },
      { ...baseItem, id: 'c' },
    ];
    render(<AgentQueueIndicator queue={items} inputHasContent={false} />);
    const header = screen.getByRole('button', { name: /collapse queue|expand queue/i });
    expect(within(header).getByText(/3 in queue/i)).toBeInTheDocument();
  });

  // The label reads `canSteer` fresh on every render; the click handler is memoised. If the two
  // diverge, a button reading "Steer" can send canSteer=false and abort the running turn.
  it('sends the CURRENT capability after a streaming transition, not the mounted one', () => {
    const onSend = vi.fn();
    const props = { queue: [baseItem], onSendNow: onSend, inputHasContent: false };
    const { rerender } = render(<AgentQueueIndicator {...props} isStreaming={false} />);
    // Mounted idle → the row says "Send now"; then a turn starts.
    rerender(<AgentQueueIndicator {...props} isStreaming={true} />);

    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));

    expect(onSend).toHaveBeenCalledWith('q1', true);
  });
});

describe('AgentQueueIndicator — turn restored without its attachments', () => {
  const lost: AgentQueueItem = {
    ...baseItem,
    id: 'lost',
    message: 'see attached',
    files: [{ id: 'f', url: '', filename: 'a.txt' }],
    attachmentsLost: true,
  };

  it('flags the row instead of claiming it still carries its files', () => {
    render(<AgentQueueIndicator queue={[lost]} onEditItem={vi.fn()} onRemoveItem={vi.fn()} />);

    expect(screen.getByText(/attachments lost/i)).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/\+1 file/)).not.toBeInTheDocument();
  });

  it('offers no Send now on that row but keeps Edit and Remove to resolve it', () => {
    const { container } = render(
      <AgentQueueIndicator
        queue={[lost, { ...baseItem, id: 'ok', message: 'fine' }]}
        onSendNow={vi.fn()}
        onEditItem={vi.fn()}
        onRemoveItem={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('button[aria-label="Send now"]').length).toBe(1);
    const row = screen.getByText('see attached').closest('[class*="border-l-2"]') as HTMLElement;
    expect(within(row).getAllByRole('button').length).toBeGreaterThanOrEqual(2);
  });
});
