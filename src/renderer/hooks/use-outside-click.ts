import { type RefObject, useEffect } from 'react';

type UseOutsideClickOptions = {
  /** Refs that count as "inside" — clicks on these won't trigger onBlur */
  refs: RefObject<HTMLElement | null>[];
  onFocus?: () => void;
  onBlur?: () => void;
};

/**
 * Fires `onBlur` when a mousedown lands outside all provided refs.
 * Radix popper content is treated as "inside" so dropdowns / context menus
 * don't accidentally dismiss the target element.
 */
export function useOutsideClick({ refs, onFocus, onBlur }: UseOutsideClickOptions): void {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // Walk up from the click target — if we hit a Radix popper wrapper
      // treat the click as "inside" (e.g. context-menu that spawned us).
      let el: HTMLElement | null = target;
      while (el) {
        if (el.hasAttribute('data-radix-popper-content-wrapper')) {
          event.stopPropagation();
          onFocus?.();
          return;
        }
        el = el.parentElement;
      }

      const isInsideRefs = refs.some((ref) => ref.current?.contains(target));

      if (!isInsideRefs) {
        onBlur?.();
      } else {
        onFocus?.();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onBlur, onFocus, refs]);
}
