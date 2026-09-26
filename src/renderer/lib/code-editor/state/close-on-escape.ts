import { hasOpenDialogLayer } from '@/lib/has-open-dialog-layer';

/**
 * Esc closes the code editor only when no layer above it (a picker, menu or dialog) is open, so
 * that layer takes Esc whichever document listener was registered first.
 */
export function closesEditorOnEscape(event: KeyboardEvent): boolean {
  return event.key === 'Escape' && !event.defaultPrevented && !hasOpenDialogLayer();
}
