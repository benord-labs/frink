// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConfirmOptions, useConfirm } from './use-confirm';

afterEach(cleanup);

const OPTIONS: ConfirmOptions = {
  title: 'Delete "Plan" permanently?',
  description: 'The chat, its history and its worktree will be removed.',
};

/** Renders the hook and exposes its confirm(); each call's settlement lands in `answers`. */
function renderConfirm() {
  let confirm: ((options: ConfirmOptions) => Promise<boolean>) | null = null;
  function Host(): ReactElement {
    const hook = useConfirm();
    confirm = hook.confirm;
    return hook.confirmDialog;
  }
  const view = render(<Host />);
  const answers: boolean[][] = [];
  const ask = (options: ConfirmOptions = OPTIONS) => {
    const settled: boolean[] = [];
    answers.push(settled);
    act(() => {
      void confirm?.(options).then((answer) => settled.push(answer));
    });
    return settled;
  };
  return { ...view, ask };
}

async function flush(): Promise<void> {
  await act(async () => {});
}

describe('useConfirm', () => {
  it('opens the dialog with the requested copy', () => {
    const { ask } = renderConfirm();
    ask();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(OPTIONS.title)).toBeInTheDocument();
    expect(screen.getByText(OPTIONS.description)).toBeInTheDocument();
  });

  it('resolves true exactly once on the destructive action', async () => {
    const { ask } = renderConfirm();
    const settled = ask();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flush();

    // AlertDialogAction also fires onOpenChange(false); that must not add a second answer.
    expect(settled).toEqual([true]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resolves false on Cancel', async () => {
    const { ask } = renderConfirm();
    const settled = ask();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();

    expect(settled).toEqual([false]);
  });

  it('resolves false on Escape', async () => {
    const { ask } = renderConfirm();
    const settled = ask();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await flush();

    expect(settled).toEqual([false]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resolves false when the owner unmounts with the dialog open', async () => {
    const { ask, unmount } = renderConfirm();
    const settled = ask();

    unmount();
    await flush();

    expect(settled).toEqual([false]);
  });

  it('resolves a superseded request false and answers the newer one', async () => {
    const { ask } = renderConfirm();
    const first = ask();
    const second = ask({ ...OPTIONS, title: 'Delete this project?' });
    await flush();

    expect(first).toEqual([false]);
    expect(screen.getByText('Delete this project?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flush();

    expect(second).toEqual([true]);
  });

  it('honours a custom confirm label and focus target', async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault());
    const { ask } = renderConfirm();
    const settled = ask({ ...OPTIONS, confirmLabel: 'Discard', onCloseAutoFocus });

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await flush();

    expect(settled).toEqual([true]);
    // Radix returns focus once the content has unmounted, which can land after the answer.
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled());
  });

  it('answers once when the destructive action is double-clicked', async () => {
    const { ask } = renderConfirm();
    const settled = ask();
    const action = screen.getByRole('button', { name: 'Delete' });

    fireEvent.click(action);
    fireEvent.click(action);
    await flush();

    expect(settled).toEqual([true]);
  });

  it('is reusable: a dismissed request does not leak its answer or focus target into the next', async () => {
    const staleFocus = vi.fn();
    const { ask } = renderConfirm();
    const first = ask({ ...OPTIONS, onCloseAutoFocus: staleFocus });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    await waitFor(() => expect(staleFocus).toHaveBeenCalledTimes(1));

    const second = ask({ ...OPTIONS, title: 'Delete this project?' });
    expect(screen.getByText('Delete this project?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flush();

    expect(first).toEqual([false]);
    expect(second).toEqual([true]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(staleFocus).toHaveBeenCalledTimes(1);
  });
});
