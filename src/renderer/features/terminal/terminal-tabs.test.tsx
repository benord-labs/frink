// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalTabs } from './terminal-tabs';

const { mutateMock, toastErrorMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    external: {
      openInTerminal: {
        useMutation: () => ({
          mutate: mutateMock,
        }),
      },
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick, disabled }: ComponentProps<'button'>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
}));

describe('TerminalTabs external terminal action', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mutateMock.mockReset();
    toastErrorMock.mockReset();
  });

  const baseProps: ComponentProps<typeof TerminalTabs> = {
    terminals: [{ id: 't1', paneId: 'chat:term:t1', name: 'Terminal 1', createdAt: Date.now() }],
    activeTerminalId: 't1',
    cwds: { 'chat:term:t1': '/tmp/current' },
    initialCwd: '/tmp/initial',
    onSelectTerminal: vi.fn(),
    onCloseTerminal: vi.fn(),
    onCloseOtherTerminals: vi.fn(),
    onCloseTerminalsToRight: vi.fn(),
    onCreateTerminal: vi.fn(),
    onRenameTerminal: vi.fn(),
  };

  it('uses tracked cwd when opening in external terminal', () => {
    render(<TerminalTabs {...baseProps} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Open in external terminal' })[0]);

    expect(mutateMock).toHaveBeenCalledWith(
      '/tmp/current',
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('falls back to initial cwd when tracked cwd is missing', () => {
    render(<TerminalTabs {...baseProps} cwds={{}} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Open in external terminal' })[0]);
    expect(mutateMock).toHaveBeenCalledWith('/tmp/initial', expect.any(Object));
  });

  it('shows toast on unsuccessful backend response', () => {
    render(<TerminalTabs {...baseProps} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in external terminal' })[0]);

    const [, callbacks] = mutateMock.mock.calls[0];
    callbacks.onSuccess({ success: false, error: 'boom' });
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('shows toast on mutation error', () => {
    render(<TerminalTabs {...baseProps} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in external terminal' })[0]);

    const [, callbacks] = mutateMock.mock.calls[0];
    callbacks.onError(new Error('network'));
    expect(toastErrorMock).toHaveBeenCalledWith('Failed to open external terminal: network');
  });
});
