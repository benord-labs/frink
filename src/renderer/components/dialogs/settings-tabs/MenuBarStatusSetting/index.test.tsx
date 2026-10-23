// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuBarStatusRow } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

describe('MenuBarStatusRow', () => {
  it('names the menu bar on a Mac and is on until the setting says otherwise', () => {
    render(<MenuBarStatusRow isMac status={undefined} onChange={vi.fn()} />);

    expect(screen.getByRole('switch', { name: 'Show Frink in the menu bar' })).toBeChecked();
    expect(screen.queryByText(/next time you open Frink/)).not.toBeInTheDocument();
  });

  it('names the system tray elsewhere and says when the change applies after a restart', () => {
    const onChange = vi.fn();
    render(
      <MenuBarStatusRow
        isMac={false}
        status={{ enabled: true, appliesOnRestart: true }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Show Frink in the system tray' }));

    expect(screen.getByText(/Takes effect the next time you open Frink/)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
