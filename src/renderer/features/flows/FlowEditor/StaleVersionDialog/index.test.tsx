// @vitest-environment happy-dom
// A refused Save offers Reload or Overwrite, and closes before either runs.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StaleVersionDialog } from './index';

function setup() {
  const onOpenChange = vi.fn();
  const onReload = vi.fn();
  const onOverwrite = vi.fn();
  render(
    <StaleVersionDialog
      open
      onOpenChange={onOpenChange}
      onReload={onReload}
      onOverwrite={onOverwrite}
    />,
  );
  return { onOpenChange, onReload, onOverwrite };
}

describe('StaleVersionDialog', () => {
  it('closes, then overwrites, when the user keeps their version', () => {
    const { onOpenChange, onOverwrite, onReload } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOverwrite).toHaveBeenCalledOnce();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('closes, then reloads, when the user takes the latest version', () => {
    const { onOpenChange, onReload, onOverwrite } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onReload).toHaveBeenCalledOnce();
    expect(onOverwrite).not.toHaveBeenCalled();
  });

  it('keeps the edits and does nothing else on Keep my edits', () => {
    const { onOpenChange, onReload, onOverwrite } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onReload).not.toHaveBeenCalled();
    expect(onOverwrite).not.toHaveBeenCalled();
  });
});
