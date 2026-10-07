/* eslint-disable project-structure/folder-structure -- shared test-only helper; it cannot use a test suffix without Vitest collecting it as a suite. */
import { act, fireEvent, screen, within } from '@testing-library/react';

/**
 * Runs a sidebar action that pauses on the in-app ConfirmDialog, answers it, then awaits the
 * action. Returns the dialog's text so callers can assert what the user was asked.
 */
export async function answerConfirm(
  action: () => Promise<unknown>,
  answer: 'confirm' | 'cancel' | 'escape',
): Promise<string> {
  let pending: Promise<unknown> = Promise.resolve();
  act(() => {
    pending = action();
  });
  const dialog = await screen.findByRole('alertdialog');
  const text = dialog.textContent ?? '';
  if (answer === 'escape') {
    fireEvent.keyDown(dialog, { key: 'Escape' });
  } else {
    const name = answer === 'confirm' ? 'Delete' : 'Cancel';
    fireEvent.click(within(dialog).getByRole('button', { name }));
  }
  await act(async () => {
    await pending;
  });
  return text;
}
