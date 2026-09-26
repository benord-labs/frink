// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Animation-free stand-ins so we assert ChatTitleEditor behaviour, not their timers.
vi.mock('../../../components/ui/typewriter-text', () => ({
  TypewriterText: ({ text, placeholder }: { text: string; placeholder?: string }) => (
    <span>{text || placeholder}</span>
  ),
}));
vi.mock('../../../components/ui/text-shimmer', () => ({
  TextShimmer: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
// Identifiable icons (Save/Cancel get their accessible name from the Button aria-label).
vi.mock('lucide-react', () => ({
  Pencil: (p: Record<string, unknown>) => <span data-testid="pencil" {...p} />,
  Check: (p: Record<string, unknown>) => <span data-testid="save-icon" {...p} />,
  X: (p: Record<string, unknown>) => <span data-testid="cancel-icon" {...p} />,
}));

import { ChatTitleEditor } from './chat-title-editor';

afterEach(cleanup);

function enterEdit() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit chat title' }));
  return screen.getByRole('textbox');
}

describe('ChatTitleEditor', () => {
  it('shows the pencil hint only when there is a real name', () => {
    const { unmount } = render(
      <ChatTitleEditor name="My Chat" hasMessages onSave={vi.fn()} chatId="c1" />,
    );
    expect(screen.getByTestId('pencil')).toBeInTheDocument();
    unmount();

    // Placeholder / not-yet-named: no pencil, not editable.
    render(<ChatTitleEditor name="" hasMessages onSave={vi.fn()} chatId="c2" />);
    expect(screen.queryByTestId('pencil')).toBeNull();
  });

  it('does NOT enter edit mode when the title text is clicked (pencil only)', () => {
    render(<ChatTitleEditor name="My Chat" hasMessages onSave={vi.fn()} chatId="c1" />);
    fireEvent.click(screen.getByText('My Chat'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('enters edit mode and Save (✓) commits the trimmed value via onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ChatTitleEditor name="My Chat" hasMessages onSave={onSave} chatId="c1" />);

    const input = enterEdit();
    fireEvent.change(input, { target: { value: '  Renamed  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Renamed'));
  });

  it('Cancel (✗) discards: does not call onSave and returns to view mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ChatTitleEditor name="My Chat" hasMessages onSave={onSave} chatId="c1" />);

    const input = enterEdit();
    fireEvent.change(input, { target: { value: 'Throwaway' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));

    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.getByRole('button', { name: 'Edit chat title' })).toBeInTheDocument();
  });

  it('keeps keyboard parity: Enter saves, Escape cancels', async () => {
    const onSaveEnter = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <ChatTitleEditor name="My Chat" hasMessages onSave={onSaveEnter} chatId="c1" />,
    );
    const input = enterEdit();
    fireEvent.change(input, { target: { value: 'Via Enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSaveEnter).toHaveBeenCalledWith('Via Enter'));
    unmount();

    const onSaveEsc = vi.fn().mockResolvedValue(undefined);
    render(<ChatTitleEditor name="My Chat" hasMessages onSave={onSaveEsc} chatId="c2" />);
    const input2 = enterEdit();
    fireEvent.change(input2, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input2, { key: 'Escape' });
    expect(onSaveEsc).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('reverts to the original name and exits edit mode when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('fail'));
    render(<ChatTitleEditor name="My Chat" hasMessages onSave={onSave} chatId="c1" />);

    const input = enterEdit();
    fireEvent.change(input, { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }));

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.getByRole('button', { name: 'Edit chat title' })).toBeInTheDocument();
    expect(screen.getByText('My Chat')).toBeInTheDocument();
  });

  it('discards (does NOT call onSave) when clicking outside the title', () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    try {
      render(<ChatTitleEditor name="My Chat" hasMessages onSave={onSave} chatId="c1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit chat title' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Throwaway' } });
      // The click-outside listener attaches after a 100ms delay.
      act(() => {
        vi.advanceTimersByTime(150);
      });
      fireEvent.mouseDown(document.body);
    } finally {
      vi.useRealTimers();
    }

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit chat title' })).toBeInTheDocument();
  });

  it('disables Save/Cancel while a save is in flight', async () => {
    // onSave never resolves → isSaving stays true.
    const onSave = vi.fn(() => new Promise<void>(() => {}));
    render(<ChatTitleEditor name="My Chat" hasMessages onSave={onSave} chatId="c1" />);

    const input = enterEdit();
    fireEvent.change(input, { target: { value: 'Saving…' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save title' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Cancel rename' })).toBeDisabled();
  });
});
