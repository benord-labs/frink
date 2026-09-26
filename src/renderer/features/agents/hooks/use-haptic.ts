import { useCallback } from 'react';

type HapticStyle = 'light' | 'medium' | 'heavy';

/**
 * Hook for triggering haptic feedback on supported devices (iOS Safari PWA).
 *
 * Uses the Vibration API which is supported on iOS Safari 13+.
 * Falls back silently on unsupported devices.
 *
 * @example
 * const { trigger } = useHaptic()
 * <button onClick={() => { trigger('light'); handleClick() }}>Click me</button>
 */
export function useHaptic() {
  const trigger = useCallback((style: HapticStyle = 'light') => {
    // Check if Vibration API is available
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      const duration = style === 'light' ? 10 : style === 'medium' ? 20 : 30;
      try {
        navigator.vibrate(duration);
      } catch {
        // Silently fail if vibration is not allowed
      }
    }
  }, []);

  return { trigger };
}
