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
