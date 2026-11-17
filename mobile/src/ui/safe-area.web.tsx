import type { ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context';

// Browser previews stand in for an iPhone with a Dynamic Island, whose safe area a browser can't
// report: 59pt clears the status bar and island, 34pt the home indicator.
const IPHONE_INSETS = { top: 59, right: 0, bottom: 34, left: 0 };

export function SafeAreaProvider({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  return (
    <SafeAreaFrameContext.Provider value={{ x: 0, y: 0, width, height }}>
      <SafeAreaInsetsContext.Provider value={IPHONE_INSETS}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  );
}
