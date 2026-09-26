// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDE_ATTACH_TIER } from '../../main/chat-composer-shell-classes';
import { ComposerAttachButton } from './index';

afterEach(cleanup);

describe('ComposerAttachButton', () => {
  it('is a named icon button that opens the picker', () => {
    const onClick = vi.fn();
    render(<ComposerAttachButton label="Attach files" onClick={onClick} disabled={false} />);
    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button).toHaveAttribute('title', 'Attach files');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('stays focusable when narrow: the tier moves it offscreen rather than removing it', () => {
    render(<ComposerAttachButton label="Attach image" onClick={vi.fn()} disabled />);
    const button = screen.getByRole('button', { name: 'Attach image' });
    expect(button).toBeDisabled();
    expect(HIDE_ATTACH_TIER).toMatch(/:sr-only$/);
    expect(button.className).toContain(HIDE_ATTACH_TIER);
  });
});
