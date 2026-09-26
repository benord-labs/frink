// @vitest-environment happy-dom

/**
 * Medium-severity: unsaved-changes dialog must dismiss via AlertDialog onOpenChange when Cancel
 * is used without a redundant onClick (Radix contract). Confirms navigate only after confirm.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alertDialogApi = vi.hoisted(() => ({
  lastOnOpenChange: null as ((open: boolean) => void) | null,
}));

const navigateSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../../../../lib/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../lib/atoms')>();
  const { atom } = await import('jotai');
  return {
    ...actual,
    navigateToAgentChatAtom: atom(null, (_get, _set, chatId: string) => {
      navigateSpy(chatId);
    }),
  };
});

vi.mock('../../../../../../components/ui/alert-dialog', () => ({
  AlertDialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    alertDialogApi.lastOnOpenChange = onOpenChange ?? null;
    return <div data-testid="alert-dialog-root">{children}</div>;
  },
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => (
    <button type="button" onClick={() => alertDialogApi.lastOnOpenChange?.(false)}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const { ResultRow } = await import('./result-row');
const { flowEditorDirtyAtom } = await import('../../../../../../lib/atoms');

function renderRow(store: ReturnType<typeof createStore>, props: Parameters<typeof ResultRow>[0]) {
  return render(
    <Provider store={store}>
      <table>
        <tbody>
          <ResultRow {...props} />
        </tbody>
      </table>
    </Provider>,
  );
}

describe('ResultRow — dirty chat navigation (medium-severity)', () => {
  afterEach(() => {
    cleanup();
    alertDialogApi.lastOnOpenChange = null;
  });

  beforeEach(() => {
    navigateSpy.mockReset();
  });

  it('navigates immediately when the flow editor is not dirty', async () => {
    const store = createStore();
    store.set(flowEditorDirtyAtom, false);
    const user = userEvent.setup();
    renderRow(store, {
      laneIndex: 0,
      branchRootNodeId: 'branch-a',
      branchLabel: 'Review branch',
      status: 'passed',
      chatId: 'chat-abc',
    });

    expect(screen.getByText('Review branch')).toBeTruthy();
    expect(screen.queryByText('branch-a')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(navigateSpy).toHaveBeenCalledWith('chat-abc');
    expect(screen.queryByText('Leave the flow editor?')).toBeNull();
  });

  it('opens the unsaved dialog when dirty; Cancel invokes onOpenChange(false) and does not navigate', async () => {
    const store = createStore();
    store.set(flowEditorDirtyAtom, true);
    const user = userEvent.setup();
    renderRow(store, {
      laneIndex: 0,
      branchRootNodeId: 'branch-a',
      branchLabel: 'Review branch',
      status: 'passed',
      chatId: 'chat-xyz',
    });

    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Leave the flow editor?')).toBeTruthy();
    expect(typeof alertDialogApi.lastOnOpenChange).toBe('function');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Leave the flow editor?')).toBeNull();
  });

  it('navigates after confirming discard when dirty', async () => {
    const store = createStore();
    store.set(flowEditorDirtyAtom, true);
    const user = userEvent.setup();
    renderRow(store, {
      laneIndex: 0,
      branchRootNodeId: 'branch-a',
      branchLabel: 'Review branch',
      status: 'passed',
      chatId: 'chat-confirm',
    });

    await user.click(screen.getByRole('button', { name: 'Chat' }));
    await user.click(screen.getByRole('button', { name: 'Open chat' }));

    expect(navigateSpy).toHaveBeenCalledWith('chat-confirm');
  });
});
