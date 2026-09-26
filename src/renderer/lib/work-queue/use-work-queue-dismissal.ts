import { hasOpenDialogLayer } from '../has-open-dialog-layer';
import { useWindowEvent } from '../hooks/use-window-event';
import { shouldDismissWorkQueue } from './should-dismiss-work-queue';

const PERMISSION_REQUESTS_SELECTOR = '[aria-label="Permission requests"]';

/** Dismiss on an unclaimed Escape while honoring interaction layers mounted elsewhere. */
export function useWorkQueueDismissal(onRequestClose: () => void): void {
  useWindowEvent('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (
      !shouldDismissWorkQueue({
        event: keyboardEvent,
        hasPermissionRequest: document.querySelector(PERMISSION_REQUESTS_SELECTOR) !== null,
        hasOpenDialogLayer: hasOpenDialogLayer(),
      })
    ) {
      return;
    }
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    onRequestClose();
  });
}
