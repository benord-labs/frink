import { confirmDestructive } from '../../ui/confirm';

/** The one confirmation for deleting a chat, from its header or a swipe in the list. */
export function confirmChatDeletion(name: string): Promise<boolean> {
  return confirmDestructive(
    `Delete “${name}”?`,
    'Its messages and its worktree on your computer are removed permanently.',
    'Delete',
  );
}

/** Stopping a Flow step's chat cancels the whole run, so it is never a single tap. */
export function confirmStopRun(): Promise<boolean> {
  return confirmDestructive('Stop run?', 'Stopping ends the whole Flow run.', 'Stop run');
}

/** Discarding a message that didn't send removes it from this phone without trying again. */
export function confirmDiscardMessage(): Promise<boolean> {
  return confirmDestructive(
    'Discard this message?',
    'It’s removed from this phone and won’t be sent again.',
    'Discard',
  );
}
