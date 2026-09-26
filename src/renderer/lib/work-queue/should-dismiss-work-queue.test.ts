// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { shouldDismissWorkQueue } from './should-dismiss-work-queue';

function escapeFrom(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('shouldDismissWorkQueue', () => {
  it('dismisses an unclaimed Escape from destination chrome', () => {
    expect(
      shouldDismissWorkQueue({
        event: new KeyboardEvent('keydown', { key: 'Escape' }),
        hasPermissionRequest: false,
        hasOpenDialogLayer: false,
      }),
    ).toBe(true);
  });

  it.each([
    { hasPermissionRequest: true, hasOpenDialogLayer: false },
    { hasPermissionRequest: false, hasOpenDialogLayer: true },
  ])('defers to a higher-priority interaction: %o', (guards) => {
    expect(
      shouldDismissWorkQueue({
        event: new KeyboardEvent('keydown', { key: 'Escape' }),
        ...guards,
      }),
    ).toBe(false);
  });

  it('defers to editable controls and the code editor', () => {
    const input = document.createElement('input');
    const editor = document.createElement('div');
    const editorChild = document.createElement('button');
    editor.setAttribute('data-code-editor-panel', 'true');
    editor.appendChild(editorChild);
    document.body.append(input, editor);

    for (const target of [input, editorChild]) {
      expect(
        shouldDismissWorkQueue({
          event: escapeFrom(target),
          hasPermissionRequest: false,
          hasOpenDialogLayer: false,
        }),
      ).toBe(false);
    }
  });

  it('defers when another handler already claimed Escape', () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    expect(
      shouldDismissWorkQueue({
        event,
        hasPermissionRequest: false,
        hasOpenDialogLayer: false,
      }),
    ).toBe(false);
  });
});
