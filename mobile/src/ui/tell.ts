import { Alert, Platform } from 'react-native';

/** A one-button message the user has to see; react-native-web has no Alert, so web uses the
 *  browser's own dialog. */
export function tell(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}
