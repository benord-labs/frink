// @vitest-environment happy-dom
/**
 * SidebarNavRow — the row look is shared by the chat sidebar and Settings, so the active and
 * emphasized fills are contracts both panes depend on, not local styling.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SIDEBAR_ROW_ACTIVE_CLASS, SidebarNavRow } from './index';

afterEach(() => {
  cleanup();
});

describe('SidebarNavRow', () => {
  it('renders a plain ghost row by default', () => {
    render(<SidebarNavRow icon={<span data-testid="icon" />} label="Flows" />);
    const row = screen.getByRole('button', { name: 'Flows' });
    expect(row.className).toContain('text-muted-foreground');
    expect(row.className).not.toContain(SIDEBAR_ROW_ACTIVE_CLASS.split(' ')[0]);
    expect(screen.getByTestId('icon')).toBeTruthy();
  });

  it('applies the shared active fill when selected', () => {
    render(<SidebarNavRow icon={null} label="Profile" active />);
    for (const cls of SIDEBAR_ROW_ACTIVE_CLASS.split(' ')) {
      expect(screen.getByRole('button', { name: 'Profile' }).className).toContain(cls);
    }
  });

  it('applies the emphasized fill for the primary action', () => {
    render(<SidebarNavRow icon={null} label="New Chat" emphasized />);
    expect(screen.getByRole('button', { name: 'New Chat' }).className).toContain('bg-foreground/6');
  });

  it('renders the trailing slot when provided', () => {
    render(
      <SidebarNavRow
        icon={null}
        label="Work Queue"
        trailing={<span data-testid="badge">3</span>}
      />,
    );
    expect(screen.getByTestId('badge').textContent).toBe('3');
  });
});
