import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useResource } from '../../lib/connection';

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

/** Only whether the Mac can run chats is needed here, so the overview's lists stay one row long. */
export function useExecutionReady() {
  const overview = useResource(
    { type: 'overview', limits: { attention: 1, running: 1, inbox: 1 } },
    { interval: 10_000 },
  );
  return overview.data?.executionReady ?? true;
}
