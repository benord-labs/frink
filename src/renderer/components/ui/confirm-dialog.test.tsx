// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const COPY = {
  title: 'Delete plan-ready task?',
  description: 'This removes it from your queue.',
};

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} {...COPY} />);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('renders the supplied copy when open', () => {
    render(<ConfirmDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} {...COPY} />);

    expect(screen.getByText(COPY.title)).toBeInTheDocument();
    expect(screen.getByText(COPY.description)).toBeInTheDocument();
  });

  it('calls onConfirm when the destructive action is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} {...COPY} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('honours a custom confirm label', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        confirmLabel="Discard"
        {...COPY}
      />,
    );

    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('requests close without confirming when Cancel is clicked', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} {...COPY} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
