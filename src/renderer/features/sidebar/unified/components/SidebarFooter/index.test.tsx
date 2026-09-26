// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsSettingsDialogActiveTabAtom, agentsSettingsDialogOpenAtom } from '@/lib/atoms';

import { DISCORD_INVITE_URL } from '../../constants';
import { SidebarFooter } from './index';

vi.mock('../../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

function renderFooter(overrides?: Partial<ComponentProps<typeof SidebarFooter>>) {
  render(
    <SidebarFooter
      onSettings={vi.fn()}
      showArchived={false}
      onToggleArchived={vi.fn()}
      archivedChatsCount={0}
      {...overrides}
    />,
  );
}

describe('SidebarFooter', () => {
  it('renders the archived chats count when greater than zero', () => {
    renderFooter({ archivedChatsCount: 2 });
    expect(screen.getByText('2')).toBeTruthy();
  });

  // Default render (no files button) is exactly: [Settings, Archive, Usage, Discord].
  it('fires onSettings then onToggleArchived for the footer actions', () => {
    const onSettings = vi.fn();
    const onToggleArchived = vi.fn();
    renderFooter({ onSettings, onToggleArchived });

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);

    fireEvent.click(buttons[0]);
    expect(onSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[1]);
    expect(onToggleArchived).toHaveBeenCalledTimes(1);
  });

  it('opens Settings on the Usage tab from the icon beside Discord', () => {
    renderFooter();

    fireEvent.click(screen.getByLabelText('Plan usage'));
    const store = getDefaultStore();
    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('usage');
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(true);
  });

  it('opens the Discord invite in the system browser', () => {
    const openExternal = vi.fn();
    vi.stubGlobal('desktopApi', { openExternal });
    renderFooter();

    fireEvent.click(screen.getByLabelText('Join our Discord'));
    expect(openExternal).toHaveBeenCalledWith(DISCORD_INVITE_URL);

    vi.unstubAllGlobals();
  });
});
