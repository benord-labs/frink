import { Alert, Platform } from 'react-native';
import { SIDE_EFFECTS_RETRY } from '@frink/shared/lib/task-recovery/side-effects-confirm';

/** A two-button destructive confirmation; the web preview uses the browser's own dialog. */
export function confirmDestructive(
  title: string,
  message: string,
  action: string,
): Promise<boolean> {
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

/** Desktop's ask before retrying a started non-agent step, which may repeat what it did. */
export function confirmSideEffectsRetry(): Promise<boolean> {
  const { title, warning, confirmLabel } = SIDE_EFFECTS_RETRY;
  return confirmDestructive(title, warning, confirmLabel);
}
