// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setPendingAccountAuthMock = vi.fn();
const setSettingsOpenMock = vi.fn();
const setSettingsActiveTabMock = vi.fn();

vi.mock('jotai', async () => {
  const actual = await vi.importActual<typeof import('jotai')>('jotai');
  // The component calls useSetAtom three times at the top, in fixed source order
  // (before any branching), so route deterministically by call index:
  //   1) pendingAccountAuthAtom  2) agentsSettingsDialogOpenAtom  3) agentsSettingsDialogActiveTabAtom
  // String(atom) doesn't carry the export name without debug labels, so the prior
  // name-match silently fell through to anonymous mocks — call order is the reliable key.
  let call = 0;
  return {
    ...actual,
    useSetAtom: () => {
      const setters = [setPendingAccountAuthMock, setSettingsOpenMock, setSettingsActiveTabMock];
      return setters[call++ % setters.length];
    },
  };
});

import { NoAccountsEmptyState } from './no-accounts-empty-state';

const ALL = ['Claude', 'OpenAI', 'OpenCode', 'GitHub Copilot', 'Cursor'];

function onPlatform(platform: string) {
  Object.defineProperty(window, 'desktopApi', { value: { platform }, configurable: true });
}

function renderEmptyState(props: Parameters<typeof NoAccountsEmptyState>[0] = {}) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <NoAccountsEmptyState {...props} />
    </Provider>,
  );
}

function connectNames(): string[] {
  return screen
    .getAllByRole('button', { name: /^Connect / })
    .map((b) => b.getAttribute('aria-label')?.replace('Connect ', '') ?? '');
}

describe('NoAccountsEmptyState', () => {
  beforeEach(() => {
    onPlatform('darwin');
    setPendingAccountAuthMock.mockClear();
    setSettingsOpenMock.mockClear();
    setSettingsActiveTabMock.mockClear();
  });

  afterEach(cleanup);

  describe('no account', () => {
    it('on macOS offers every provider in table order, each opening its connect page', () => {
      renderEmptyState();
      expect(screen.getByText('Frink works through your own AI account.')).toBeInTheDocument();
      expect(connectNames()).toEqual(ALL);
      const ids = ['claude-code', 'codex', 'opencode', 'copilot', 'cursor'];
      for (const [i, name] of ALL.entries()) {
        screen.getByRole('button', { name: `Connect ${name}` }).click();
        expect(setPendingAccountAuthMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ mode: 'add', provider: ids[i] }),
        );
      }
      expect(screen.getByText('Free models, or your own AI provider')).toBeInTheDocument();
      screen.getByRole('button', { name: 'Add it in Settings' }).click();
      expect(setSettingsActiveTabMock).toHaveBeenCalledWith('models');
      expect(setSettingsOpenMock).toHaveBeenCalledWith(true);
    });

    it('on Linux offers only Claude and OpenAI: installed agents run on macOS only', () => {
      onPlatform('linux');
      renderEmptyState();
      expect(connectNames()).toEqual(['Claude', 'OpenAI']);
    });

    it('on Windows replaces every sign-in with an API key button and says why', () => {
      onPlatform('win32');
      renderEmptyState();
      expect(screen.queryByRole('button', { name: /^Connect/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add an API key' })).toBeInTheDocument();
      expect(screen.getByText(/your own account needs macOS or Linux/i)).toBeInTheDocument();
    });
  });

  describe('signed-out account', () => {
    const existingAccount = { label: 'Personal Claude', type: 'claude-code' } as const;

    it('re-authenticates that account and offers every other provider as a switch', () => {
      renderEmptyState({ existingAccount });
      expect(screen.getByText('Claude · Signed out')).toBeInTheDocument();
      screen.getByRole('button', { name: 'Sign in again' }).click();
      expect(setPendingAccountAuthMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'reauth', accountLabel: 'Personal Claude' }),
      );
      expect(connectNames()).toEqual(ALL.slice(1));
    });

    it('compact card signs back in or switches to the next provider, the rest under More', async () => {
      renderEmptyState({ compact: true, existingAccount });
      expect(
        screen.getByRole('heading', { name: 'Personal Claude was signed out' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      expect(connectNames()).toEqual(['OpenAI']);
      await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Connect OpenCode',
        'Connect GitHub Copilot',
        'Connect Cursor',
      ]);
    });
  });

  describe('compact card', () => {
    it('shows two providers as buttons and connects the rest from More', async () => {
      renderEmptyState({ compact: true });
      expect(connectNames()).toEqual(['Claude', 'OpenAI']);
      await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
      const menu = screen.getByRole('menu');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['Connect OpenCode', 'Connect GitHub Copilot', 'Connect Cursor']);
      await userEvent.setup().click(within(menu).getByRole('menuitem', { name: 'Connect Cursor' }));
      expect(setPendingAccountAuthMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'add', provider: 'cursor' }),
      );
    });

    it('has no More button when every provider fits', () => {
      onPlatform('linux');
      renderEmptyState({ compact: true });
      expect(connectNames()).toEqual(['Claude', 'OpenAI']);
      expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    });

    // The transcript scrolls under the composer slot, so a card narrower than the composer column
    // would leave message lines sharp on either side of it.
    it('spans the composer column as a slot surface', () => {
      renderEmptyState({ compact: true });
      const card = screen.getByTestId('no-accounts-empty-state');
      expect(card.className).not.toMatch(/\bmax-w-/);
      expect(card).toHaveClass('composer-slot-surface');
    });
  });
});
