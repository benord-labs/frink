// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoModeToggle } from './auto-mode-toggle';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('AutoModeToggle', () => {
  it('is a keyboard-operable manual toggle with an explicit pressed state', async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AutoModeToggle
        checked={false}
        onCheckedChange={onCheckedChange}
        available
        unavailableReason=""
      />,
    );

    const button = screen.getByRole('button', { name: /Auto Mode off/i });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('stays rendered and explains why Auto is unavailable', () => {
    render(
      <AutoModeToggle
        checked={false}
        onCheckedChange={vi.fn()}
        available={false}
        unavailableReason="Auto Mode is unavailable in Plan mode."
      />,
    );

    const button = screen.getByRole('button', { name: /unavailable.*Plan mode/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Auto Mode is unavailable in Plan mode.');
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  // A Flow seeds this control's value rather than owning it, so the user can always change it back.
  it.each([
    [true, /^Auto Mode on/],
    [false, /^Auto Mode off/],
  ])('stays editable and named %s however the value was set', (checked, label) => {
    render(
      <AutoModeToggle checked={checked} onCheckedChange={vi.fn()} available unavailableReason="" />,
    );

    const button = screen.getByRole('button', { name: /Auto Mode/i });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-label', expect.stringMatching(label));
    expect(button).toHaveAttribute('title', expect.stringMatching(label));
    expect(button).toHaveAttribute('aria-pressed', String(checked));
  });
});
