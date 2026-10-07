// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

// Mutable per-test OS switch (default non-Windows so the existing tests keep their happy path).
const platformMock = vi.hoisted(() => ({ isWindows: vi.fn(() => false) }));
vi.mock('@/lib/utils/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/platform')>();
  return { ...actual, isWindows: platformMock.isWindows };
});

import { NoAccountsEmptyState } from './no-accounts-empty-state';

function renderEmptyState(props: Parameters<typeof NoAccountsEmptyState>[0] = {}) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <NoAccountsEmptyState {...props} />
    </Provider>,
  );
}

describe('NoAccountsEmptyState', () => {
  beforeEach(() => {
    setPendingAccountAuthMock.mockClear();
    setSettingsOpenMock.mockClear();
    setSettingsActiveTabMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    platformMock.isWindows.mockReturnValue(false);
  });

  describe('no account', () => {
    it('names both providers and offers each sign-in plus an API key link', () => {
      renderEmptyState();
      expect(screen.getByText(/your own Claude or OpenAI account/i)).toBeInTheDocument();
      screen.getByRole('button', { name: 'Connect Claude' }).click();
      expect(setPendingAccountAuthMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'add', provider: 'claude-code' }),
      );
      screen.getByRole('button', { name: 'Connect OpenAI' }).click();
      expect(setPendingAccountAuthMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'add', provider: 'codex' }),
      );
      screen.getByRole('button', { name: 'Add it in Settings' }).click();
      expect(setSettingsActiveTabMock).toHaveBeenCalledWith('models');
      expect(setSettingsOpenMock).toHaveBeenCalledWith(true);
    });

    it('on Windows replaces both sign-ins with an API key button and says why', () => {
      // Claude and Codex passthrough are macOS/Linux only.
      platformMock.isWindows.mockReturnValue(true);
      renderEmptyState();
      expect(screen.queryByRole('button', { name: /^Connect/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add an API key' })).toBeInTheDocument();
      expect(screen.getByText(/Claude or OpenAI needs macOS or Linux/i)).toBeInTheDocument();
    });
  });

  describe('signed-out account', () => {
    const existingAccount = { label: 'Personal Claude', type: 'claude-code' } as const;

    it('re-authenticates that account and offers the other provider as a switch', () => {
      renderEmptyState({ existingAccount });
      expect(screen.getByText('Claude · Signed out')).toBeInTheDocument();
      screen.getByRole('button', { name: 'Sign in again' }).click();
      expect(setPendingAccountAuthMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'reauth', accountLabel: 'Personal Claude' }),
      );
      expect(screen.getByRole('button', { name: 'Connect OpenAI' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Claude' })).not.toBeInTheDocument();
    });

    it('compact card names the account and keeps the same two actions', () => {
      renderEmptyState({ compact: true, existingAccount });
      expect(
        screen.getByRole('heading', { name: 'Personal Claude was signed out' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect OpenAI' })).toBeInTheDocument();
    });
  });

  // The transcript scrolls under the composer slot, so a card narrower than the composer column
  // would leave message lines sharp on either side of it.
  it('compact card spans the composer column as a slot surface', () => {
    renderEmptyState({ compact: true });
    const card = screen.getByTestId('no-accounts-empty-state');
    expect(card.className).not.toMatch(/\bmax-w-/);
    expect(card).toHaveClass('composer-slot-surface');
  });
});
