// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkQueueDismissal } from './use-work-queue-dismissal';

function Harness({ onDismiss }: { onDismiss: () => void }) {
  useWorkQueueDismissal(onDismiss);
  return null;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('useWorkQueueDismissal', () => {
  it('checks the global permission surface at Escape time', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const permissionSurface = document.createElement('section');
    permissionSurface.setAttribute('aria-label', 'Permission requests');
    document.body.appendChild(permissionSurface);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();

    permissionSurface.remove();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('defers to an open alert dialog', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const alertDialog = document.createElement('div');
    alertDialog.setAttribute('role', 'alertdialog');
    alertDialog.setAttribute('data-state', 'open');
    document.body.appendChild(alertDialog);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('lets the editor claim the first Escape before dismissing on the next one', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    let editorOpen = true;
    const closeEditor = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !editorOpen) return;
      editorOpen = false;
      event.stopPropagation();
    };
    document.addEventListener('keydown', closeEditor, true);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    document.removeEventListener('keydown', closeEditor, true);
  });
});
