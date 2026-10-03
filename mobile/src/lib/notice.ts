import { Alert, Platform } from 'react-native';

/** A one-button system notice: an iOS alert, or the browser dialog on web previews. */
export function showNotice(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}
