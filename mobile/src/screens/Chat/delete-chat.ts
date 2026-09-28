import { Alert, Platform } from 'react-native';

const MESSAGE = 'Its messages and its worktree on your computer are removed permanently.';

/** The one confirmation for deleting a chat, from its header or a swipe in the list. */
export function confirmChatDeletion(name: string): Promise<boolean> {
  const title = `Delete “${name}”?`;
  // react-native-web has no Alert; the browser's own dialog keeps the web preview honest.
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${MESSAGE}`));
  return new Promise((resolve) =>
    Alert.alert(
      title,
      MESSAGE,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}
