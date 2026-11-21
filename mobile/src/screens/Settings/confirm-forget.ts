import { Alert, Platform } from 'react-native';
import { forgetPrompt } from './settings-view';

/** The system confirm: an iOS alert with a destructive button, or the browser dialog on web previews. */
export function confirmForget(name: string): Promise<boolean> {
  const { title, message } = forgetPrompt(name);
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Forget', style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}
