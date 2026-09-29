import { Alert, Platform } from 'react-native';

/** A two-button destructive confirmation; the web preview uses the browser's own dialog. */
function confirmDestructive(title: string, message: string, action: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: action, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

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
