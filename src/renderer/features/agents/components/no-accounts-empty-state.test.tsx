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

  describe('first-time mode (no existing account)', () => {
    it('advertises Claude and OpenAI in the description', () => {
      renderEmptyState();
      expect(screen.getByText(/Frink supports Claude.*and OpenAI/i)).toBeInTheDocument();
    });

    it('renders the Claude passthrough CTA AND the API key CTA', () => {
      renderEmptyState();
      expect(screen.getByRole('button', { name: /connect claude/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add api key/i })).toBeInTheDocument();
    });

    it('renders the Codex passthrough CTA and routes to the Codex connect page on click', () => {
      renderEmptyState();
      const codexCta = screen.getByRole('button', { name: /connect openai/i });
      expect(codexCta).toBeInTheDocument();
      codexCta.click();
      expect(setPendingAccountAuthMock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'add', provider: 'codex' }),
      );
    });

    it('Windows hides the Codex Connect CTA and shows the Mac/Linux codex passthrough note', () => {
      // Codex passthrough is mac/linux-only: the Windows note reads "Claude and OpenAI …", CTA hidden.
      platformMock.isWindows.mockReturnValue(true);
      renderEmptyState();
      expect(screen.queryByRole('button', { name: /connect openai/i })).not.toBeInTheDocument();
      expect(screen.getByText(/Claude and OpenAI passthrough/i)).toBeInTheDocument();
    });

    it('does not show the reconnect heading', () => {
      renderEmptyState();
      expect(screen.queryByText(/Reconnect to keep chatting/i)).not.toBeInTheDocument();
    });
  });

  describe('existing-account mode — Claude row needs reauth', () => {
    it('renders the reconnect heading and surfaces the row label', () => {
      renderEmptyState({ existingAccount: { label: 'Personal Claude', type: 'claude-code' } });
      expect(screen.getByText(/Reconnect to keep chatting/i)).toBeInTheDocument();
      // Visible description + sr-only live-region both contain the label.
      expect(screen.getAllByText(/Personal Claude/).length).toBeGreaterThanOrEqual(1);
    });

    it('renders a Reconnect Claude CTA (not the Connect first-time CTA)', () => {
      renderEmptyState({ existingAccount: { label: 'Personal Claude', type: 'claude-code' } });
      expect(screen.getByRole('button', { name: /reconnect claude/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^connect claude/i })).not.toBeInTheDocument();
    });

    it('does not surface the "Add API key" CTA in reauth mode', () => {
      renderEmptyState({ existingAccount: { label: 'Personal Claude', type: 'claude-code' } });
      expect(screen.queryByRole('button', { name: /add api key/i })).not.toBeInTheDocument();
    });
  });

  // The transcript scrolls under the composer slot, so a card narrower than the composer column
  // would leave message lines sharp on either side of it.
  it('compact card spans the composer column; the full card keeps its narrow width', () => {
    const existingAccount = { label: 'Personal Claude', type: 'claude-code' } as const;
    const { unmount } = renderEmptyState({ compact: true, existingAccount });
    expect(screen.getByTestId('no-accounts-empty-state').className).not.toMatch(/\bmax-w-/);
    unmount();
    renderEmptyState({ existingAccount });
    expect(screen.getByTestId('no-accounts-empty-state')).toHaveClass('max-w-md');
  });

  it('compact card is a slot surface, so a stacked card on it squares its top', () => {
    renderEmptyState({ compact: true });
    expect(screen.getByTestId('no-accounts-empty-state')).toHaveClass('composer-slot-surface');
  });
});
