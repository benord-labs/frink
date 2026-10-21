// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingSwitchRow } from '.';

afterEach(cleanup);

describe('SettingSwitchRow', () => {
  it('names the switch by its label and describes it by its description', () => {
    render(
      <SettingSwitchRow
        id="row"
        label="Pause on failure"
        description="A failure pauses the run."
        checked={false}
        onCheckedChange={() => {}}
      >
        <p>Extra note</p>
      </SettingSwitchRow>,
    );

    const toggle = screen.getByRole('switch', { name: 'Pause on failure' });
    expect(toggle).toHaveAccessibleDescription('A failure pauses the run.');
    expect(screen.getByText('Extra note')).toBeInTheDocument();
  });

  it('reports the new value when switched', () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingSwitchRow
        id="row"
        label="Auto Mode"
        description="Reviews approvals."
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Auto Mode' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('ignores clicks while disabled', () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingSwitchRow
        id="row"
        label="Flow enabled"
        description="Blocks triggers when off."
        checked
        disabled
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'Flow enabled' });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
