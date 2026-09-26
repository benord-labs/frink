import { useCallback, useRef } from 'react';

/**
 * Lets a context menu action transfer focus to a newly mounted input without
 * Radix auto-refocusing the trigger on close.
 */
export function useContextMenuFocusHandoff(): {
  markNextCloseForInputFocus: () => void;
  handleCloseAutoFocus: (event: Event) => void;
} {
  const shouldPreventCloseAutoFocusRef = useRef(false);

  const markNextCloseForInputFocus = useCallback(() => {
    shouldPreventCloseAutoFocusRef.current = true;
  }, []);

  const handleCloseAutoFocus = useCallback((event: Event) => {
    if (!shouldPreventCloseAutoFocusRef.current) return;
    shouldPreventCloseAutoFocusRef.current = false;
    event.preventDefault();
  }, []);

  return {
    markNextCloseForInputFocus,
    handleCloseAutoFocus,
  };
}
