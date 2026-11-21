import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useOverview } from '../../lib/overview';

const ios = Platform.OS === 'ios';

/** The home-indicator gap only applies while the keyboard is down. */
export function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!ios) return;
    const show = Keyboard.addListener('keyboardWillShow', () => setShown(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/** Whether the computer can run chats, read from the app-wide overview poll. */
export function useExecutionReady() {
  return useOverview().data?.executionReady ?? true;
}
