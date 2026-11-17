import { useEffect, type RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, Keyboard, Platform, type View } from 'react-native';

/** Transparent screens retain their underlay; keep keyboard focus inside this modal too. */
export function useHistoryFocus(
  panel: RefObject<View | null>,
  closeButton: RefObject<View | null>,
  close: () => void,
) {
  useEffect(() => {
    if (Platform.OS !== 'web') {
      Keyboard.dismiss();
      const frame = requestAnimationFrame(() => {
        const handle = findNodeHandle(closeButton.current);
        if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
      });
      return () => cancelAnimationFrame(frame);
    }
    const element = panel.current;
    if (!(element instanceof HTMLElement)) return;
    const opener = document.activeElement;
    const controls = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button, input, [role="button"], [role="tab"], [tabindex]',
        ),
      ).filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.matches(':disabled, [aria-disabled="true"]') &&
          !node.closest('[aria-hidden="true"]') &&
          node.getClientRects().length > 0,
      );
    const focusFirst = () => controls()[0]?.focus();
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) focusFirst();
    };
    // Reason: Keyboard trapping has browser tests; CRAP estimates zero without their coverage map.
    // fallow-ignore-next-line complexity
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const frame = requestAnimationFrame(focusFirst);
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('keydown', key, true);
      requestAnimationFrame(() => {
        if (
          opener instanceof HTMLElement &&
          opener.isConnected &&
          !opener.closest('[aria-hidden="true"]')
        )
          opener.focus();
      });
    };
  }, [panel, closeButton, close]);
}
