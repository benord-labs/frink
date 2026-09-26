import { isEditableKeyboardTarget } from '../is-editable-keyboard-target';

type Input = {
  event: KeyboardEvent;
  hasPermissionRequest: boolean;
  hasOpenDialogLayer: boolean;
};

/** Preserve the Escape priority stack above the Work Queue destination. */
export function shouldDismissWorkQueue({
  event,
  hasPermissionRequest,
  hasOpenDialogLayer,
}: Input): boolean {
  if (
    event.key !== 'Escape' ||
    event.defaultPrevented ||
    hasPermissionRequest ||
    hasOpenDialogLayer ||
    isEditableKeyboardTarget(event.target)
  ) {
    return false;
  }
  return !(
    event.target instanceof Element && event.target.closest('[data-code-editor-panel="true"]')
  );
}
