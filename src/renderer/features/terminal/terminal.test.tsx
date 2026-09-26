// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivePalette } from '@/lib/themes/palette/apply';
import { derivePalette } from '@/lib/themes/palette/derive';
import { getTerminalTheme } from '@/lib/themes/terminal-theme';
import { Terminal } from './terminal';

const {
  writeMutateMock,
  createOrAttachMutateMock,
  resizeMutateMock,
  detachMutateMock,
  clearScrollbackMutateMock,
  setGlobalCwdsMock,
  toastErrorMock,
  toastSuccessMock,
  xtermFocusMock,
  lastMockTextareaRef,
  xtermFocusHandlerRef,
  activePaletteMock,
  createInstanceMock,
} = vi.hoisted(() => {
  const focusMock = vi.fn();
  const ref = { current: null as HTMLTextAreaElement | null };
  const focusHandlerRef = { current: null as (() => void) | null };
  return {
    writeMutateMock: vi.fn(),
    createOrAttachMutateMock: vi.fn(),
    resizeMutateMock: vi.fn(),
    detachMutateMock: vi.fn(),
    clearScrollbackMutateMock: vi.fn(),
    setGlobalCwdsMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    xtermFocusMock: focusMock,
    lastMockTextareaRef: ref,
    xtermFocusHandlerRef: focusHandlerRef,
    activePaletteMock: vi.fn((): ActivePalette | null => null),
    createInstanceMock: vi.fn(),
  };
});

let onDataHandler: ((data: string) => void) | null = null;
let onDialogOpenChangeHandler: ((open: boolean) => void) | null = null;
let streamOnDataHandler:
  | ((event: { type: 'data' | 'exit'; data?: string; exitCode?: number }) => void)
  | null = null;

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

vi.mock('jotai', async () => {
  const actual = await vi.importActual<typeof import('jotai')>('jotai');
  return {
    ...actual,
    atom: actual.atom,
    useAtomValue: () => activePaletteMock(),
    useSetAtom: () => setGlobalCwdsMock,
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    terminal: {
      createOrAttach: {
        useMutation: () => ({
          mutate: createOrAttachMutateMock,
        }),
      },
      write: {
        useMutation: () => ({
          mutate: writeMutateMock,
        }),
      },
      resize: {
        useMutation: () => ({
          mutate: resizeMutateMock,
        }),
      },
      detach: {
        useMutation: () => ({
          mutate: detachMutateMock,
        }),
      },
      clearScrollback: {
        useMutation: () => ({
          mutate: clearScrollbackMutateMock,
        }),
      },
      stream: {
        useSubscription: (
          _paneId: string,
          options: {
            onData?: (event: { type: 'data' | 'exit'; data?: string; exitCode?: number }) => void;
          },
        ) => {
          streamOnDataHandler = options.onData ?? null;
        },
      },
    },
  },
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    onDialogOpenChangeHandler = onOpenChange ?? null;
    return <>{children}</>;
  },
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('./helpers', () => ({
  createTerminalInstance: (...args: unknown[]) => {
    createInstanceMock(...args);
    const ta = document.createElement('textarea');
    lastMockTextareaRef.current = ta;
    return {
      xterm: {
        cols: 80,
        rows: 24,
        write: vi.fn(),
        writeln: vi.fn(),
        clear: vi.fn(),
        focus: xtermFocusMock,
        dispose: vi.fn(),
        options: {},
        textarea: ta,
        onData: (cb: (data: string) => void) => {
          onDataHandler = cb;
          return { dispose: vi.fn() };
        },
        onKey: () => ({ dispose: vi.fn() }),
        loadAddon: vi.fn(),
      },
      fitAddon: {},
      serializeAddon: { serialize: () => '' },
      cleanup: vi.fn(),
    };
  },
  setupClickToMoveCursor: () => vi.fn(),
  setupContextMenuHandler: () => vi.fn(),
  setupFocusListener: (_xterm: unknown, onFocus: () => void) => {
    xtermFocusHandlerRef.current = onFocus;
    return () => {
      xtermFocusHandlerRef.current = null;
    };
  },
  setupKeyboardHandler: () => vi.fn(),
  setupPasteHandler: () => vi.fn(),
  setupResizeHandlers: () => vi.fn(),
}));

vi.mock('./TerminalSearch', () => ({
  TerminalSearch: () => null,
}));

function resetTerminalTestState(): void {
  cleanup();
  writeMutateMock.mockReset();
  createOrAttachMutateMock.mockReset();
  resizeMutateMock.mockReset();
  detachMutateMock.mockReset();
  clearScrollbackMutateMock.mockReset();
  setGlobalCwdsMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  xtermFocusMock.mockReset();
  onDataHandler = null;
  onDialogOpenChangeHandler = null;
  streamOnDataHandler = null;
  xtermFocusHandlerRef.current = null;
  activePaletteMock.mockReset();
  createInstanceMock.mockReset();
}

beforeEach(() => {
  resetTerminalTestState();
});

describe('Terminal cwd switch orchestration', () => {
  it('auto-switches with cd when terminal is pristine and cwd changes', () => {
    const { rerender } = render(<Terminal paneId="p1" cwd="/project-a" workspaceId="ws1" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    rerender(<Terminal paneId="p1" cwd="/project-b" workspaceId="ws1" />);

    expect(writeMutateMock).toHaveBeenCalledWith({
      paneId: 'p1',
      data: 'cd /project-b\n',
    });
  });

  it('prompts instead of auto-switching when user has interacted', () => {
    const { rerender } = render(<Terminal paneId="p2" cwd="/project-a" workspaceId="ws2" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('ls');

    rerender(<Terminal paneId="p2" cwd="/project-b" workspaceId="ws2" />);

    expect(screen.getByText('Switch terminal directory?')).toBeTruthy();
  });

  it('keeps current directory and suppresses same prompt after Keep current directory', () => {
    const { rerender } = render(<Terminal paneId="p3" cwd="/project-a" workspaceId="ws3" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('ls');
    rerender(<Terminal paneId="p3" cwd="/project-b" workspaceId="ws3" />);
    expect(screen.getByText('Switch terminal directory?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep current directory' }));
    rerender(<Terminal paneId="p3" cwd="/project-b" workspaceId="ws3" />);

    expect(screen.queryByText('Switch terminal directory?')).toBeNull();
  });

  it('moves directory when Move directory is clicked', () => {
    const { rerender } = render(<Terminal paneId="p4" cwd="/project-a" workspaceId="ws4" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('ls\n');
    rerender(<Terminal paneId="p4" cwd="/project-b" workspaceId="ws4" />);
    fireEvent.click(screen.getByRole('button', { name: 'Move directory' }));

    expect(writeMutateMock).toHaveBeenCalledWith({
      paneId: 'p4',
      data: 'cd /project-b\n',
    });
  });

  it('detaches terminal and suppresses same pending prompt', () => {
    const { rerender } = render(<Terminal paneId="p5" cwd="/project-a" workspaceId="ws5" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('ls');
    rerender(<Terminal paneId="p5" cwd="/project-b" workspaceId="ws5" />);
    fireEvent.click(screen.getByRole('button', { name: 'Detach terminal' }));
    expect(detachMutateMock).toHaveBeenCalledWith({
      paneId: 'p5',
      serializedState: '',
    });
    rerender(<Terminal paneId="p5" cwd="/project-b" workspaceId="ws5" />);

    expect(screen.queryByText('Switch terminal directory?')).toBeNull();
  });

  it('treats dialog close via onOpenChange(false) as keep-current', () => {
    const { rerender } = render(<Terminal paneId="p6" cwd="/project-a" workspaceId="ws6" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('echo pending');
    rerender(<Terminal paneId="p6" cwd="/project-b" workspaceId="ws6" />);
    onDialogOpenChangeHandler?.(false);
    rerender(<Terminal paneId="p6" cwd="/project-b" workspaceId="ws6" />);

    expect(screen.queryByText('Switch terminal directory?')).toBeNull();
  });

  it('prompts when there is pending unsent input', () => {
    const { rerender } = render(<Terminal paneId="p7" cwd="/project-a" workspaceId="ws7" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('partial-command');
    rerender(<Terminal paneId="p7" cwd="/project-b" workspaceId="ws7" />);

    expect(screen.getByText('Switch terminal directory?')).toBeTruthy();
  });

  it('does not switch directory from dialog when unsent input is still pending', () => {
    const { rerender } = render(<Terminal paneId="p7b" cwd="/project-a" workspaceId="ws7b" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('partial-command');
    rerender(<Terminal paneId="p7b" cwd="/project-b" workspaceId="ws7b" />);
    fireEvent.click(screen.getByRole('button', { name: 'Move directory' }));

    expect(writeMutateMock).not.toHaveBeenCalledWith({
      paneId: 'p7b',
      data: 'cd /project-b\n',
    });
    expect(screen.getByText('Switch terminal directory?')).toBeTruthy();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Finish or clear the current command before switching directories.',
    );
  });

  it('uses latest cwd when rapid project switches happen while dialog is open', () => {
    const { rerender } = render(<Terminal paneId="p8" cwd="/project-a" workspaceId="ws8" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('ls\n');
    rerender(<Terminal paneId="p8" cwd="/project-b" workspaceId="ws8" />);
    expect(screen.getByText('/project-b')).toBeTruthy();

    rerender(<Terminal paneId="p8" cwd="/project-c" workspaceId="ws8" />);
    expect(screen.getByText('/project-c')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Move directory' }));
    expect(writeMutateMock).toHaveBeenCalledWith({
      paneId: 'p8',
      data: 'cd /project-c\n',
    });
  });

  it('refuses cwd auto-switch when terminal is exited', () => {
    const { rerender } = render(<Terminal paneId="p9" cwd="/project-a" workspaceId="ws9" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    streamOnDataHandler?.({ type: 'exit', exitCode: 0 });
    rerender(<Terminal paneId="p9" cwd="/project-b" workspaceId="ws9" />);

    expect(writeMutateMock).not.toHaveBeenCalledWith({
      paneId: 'p9',
      data: 'cd /project-b\n',
    });
  });

  it('preserves requested cwd while exited and uses it on restart', () => {
    const { rerender } = render(<Terminal paneId="p10" cwd="/project-a" workspaceId="ws10" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    streamOnDataHandler?.({ type: 'exit', exitCode: 0 });
    rerender(<Terminal paneId="p10" cwd="/project-b" workspaceId="ws10" />);

    expect(writeMutateMock).not.toHaveBeenCalledWith({
      paneId: 'p10',
      data: 'cd /project-b\n',
    });

    onDataHandler?.('x');
    expect(createOrAttachMutateMock.mock.calls[1]?.[0]).toMatchObject({
      paneId: 'p10',
      cwd: '/project-b',
    });
  });

  it('uses the latest requested cwd when multiple cwd updates happen while exited', () => {
    const { rerender } = render(<Terminal paneId="p11" cwd="/project-a" workspaceId="ws11" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    streamOnDataHandler?.({ type: 'exit', exitCode: 0 });
    rerender(<Terminal paneId="p11" cwd="/project-b" workspaceId="ws11" />);
    rerender(<Terminal paneId="p11" cwd="/project-c" workspaceId="ws11" />);

    onDataHandler?.('x');
    expect(createOrAttachMutateMock.mock.calls[1]?.[0]).toMatchObject({
      paneId: 'p11',
      cwd: '/project-c',
    });
  });

  it('restarts once after exit and does not forward the restart keypress as terminal input', () => {
    const { rerender } = render(<Terminal paneId="p12" cwd="/project-a" workspaceId="ws12" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    streamOnDataHandler?.({ type: 'exit', exitCode: 0 });
    rerender(<Terminal paneId="p12" cwd="/project-b" workspaceId="ws12" />);
    onDataHandler?.('x');

    expect(createOrAttachMutateMock).toHaveBeenCalledTimes(2);
    expect(writeMutateMock).not.toHaveBeenCalledWith({ paneId: 'p12', data: 'x' });
  });

  it('does not prompt while exited and applies cwd update on restart', () => {
    const { rerender } = render(<Terminal paneId="p13" cwd="/project-a" workspaceId="ws13" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('partial');
    streamOnDataHandler?.({ type: 'exit', exitCode: 0 });
    rerender(<Terminal paneId="p13" cwd="/project-b" workspaceId="ws13" />);

    expect(screen.queryByText('Switch terminal directory?')).toBeNull();

    onDataHandler?.('x');
    expect(createOrAttachMutateMock.mock.calls[1]?.[0]).toMatchObject({
      paneId: 'p13',
      cwd: '/project-b',
    });
  });

  it('allows Move directory when prior input was submitted with newline', () => {
    const { rerender } = render(<Terminal paneId="p14" cwd="/project-a" workspaceId="ws14" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('partial');
    onDataHandler?.('\n');
    rerender(<Terminal paneId="p14" cwd="/project-b" workspaceId="ws14" />);
    fireEvent.click(screen.getByRole('button', { name: 'Move directory' }));

    expect(writeMutateMock).toHaveBeenCalledWith({
      paneId: 'p14',
      data: 'cd /project-b\n',
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('resets cwd switch state when session identity changes', () => {
    const { rerender } = render(
      <Terminal paneId="p15" cwd="/project-a" workspaceId="ws15" tabId="tab-a" />,
    );
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    onDataHandler?.('partial');
    rerender(<Terminal paneId="p15" cwd="/project-b" workspaceId="ws15" tabId="tab-a" />);
    expect(screen.getByText('Switch terminal directory?')).toBeTruthy();

    rerender(
      <Terminal
        paneId="p15"
        cwd="/initial-c"
        workspaceId="ws15"
        tabId="tab-b"
        initialCwd="/initial-c"
      />,
    );

    expect(screen.queryByText('Switch terminal directory?')).toBeNull();
    expect(setGlobalCwdsMock).toHaveBeenCalled();
    const lastGlobalCwdCall = setGlobalCwdsMock.mock.calls.at(-1)?.[0];
    const nextState =
      typeof lastGlobalCwdCall === 'function'
        ? lastGlobalCwdCall({ p15: '/old' })
        : lastGlobalCwdCall;
    expect(nextState).toMatchObject({ p15: '/initial-c' });
  });

  it('keeps global cwd updates scoped by pane id in multi-pane renders', () => {
    setGlobalCwdsMock.mockReset();

    const paneA = render(<Terminal paneId="p16a" cwd="/pane-a" workspaceId="ws16" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });

    const paneB = render(<Terminal paneId="p16b" cwd="/pane-b" workspaceId="ws16" />);
    createOrAttachMutateMock.mock.calls[1]?.[1]?.onSuccess?.({ serializedState: '' });

    paneA.rerender(<Terminal paneId="p16a" cwd="/pane-a-next" workspaceId="ws16" />);
    paneB.rerender(<Terminal paneId="p16b" cwd="/pane-b-next" workspaceId="ws16" />);

    const updaterFns = setGlobalCwdsMock.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is (prev: Record<string, string>) => Record<string, string> => {
        return typeof arg === 'function';
      });

    const finalState = updaterFns.reduce<Record<string, string>>(
      (prev, updater) => updater(prev),
      {},
    );
    expect(finalState).toMatchObject({
      p16a: '/pane-a-next',
      p16b: '/pane-b-next',
    });
  });
});

describe('split-chat pane activity', () => {
  it('does not focus xterm on attach when isPaneActive is false (inactive column mount)', () => {
    render(<Terminal paneId="psplit" cwd="/" workspaceId="ws-split" isPaneActive={false} />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
    expect(xtermFocusMock).not.toHaveBeenCalled();
  });

  it('focuses xterm on attach when pane is active', () => {
    render(<Terminal paneId="psplit2" cwd="/" workspaceId="ws-split2" />);
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
    expect(xtermFocusMock).toHaveBeenCalled();
  });

  it('does not focus xterm when attach completes after user switched to another chat pane', () => {
    const { rerender } = render(
      <Terminal paneId="psplit-late" cwd="/" workspaceId="ws-split-late" isPaneActive />,
    );
    expect(createOrAttachMutateMock).toHaveBeenCalled();
    rerender(
      <Terminal paneId="psplit-late" cwd="/" workspaceId="ws-split-late" isPaneActive={false} />,
    );
    xtermFocusMock.mockClear();
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
    expect(xtermFocusMock).not.toHaveBeenCalled();
  });

  it('blurs xterm textarea when isPaneActive becomes false', async () => {
    const { rerender } = render(
      <Terminal paneId="psplit3" cwd="/" workspaceId="ws-split3" isPaneActive />,
    );
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
    const ta = lastMockTextareaRef.current;
    expect(ta).toBeTruthy();
    const textarea = ta as HTMLTextAreaElement;
    document.body.appendChild(textarea);
    textarea.focus();
    const blurSpy = vi.spyOn(textarea, 'blur');

    try {
      rerender(<Terminal paneId="psplit3" cwd="/" workspaceId="ws-split3" isPaneActive={false} />);

      await waitFor(() => {
        expect(blurSpy).toHaveBeenCalled();
      });
    } finally {
      blurSpy.mockRestore();
      textarea.remove();
    }
  });

  it('does not rAF-focus xterm when only isPaneActive becomes true (switching into this chat pane)', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const { rerender } = render(
        <Terminal paneId="pswitch-in" cwd="/" workspaceId="ws-switch" isPaneActive={false} />,
      );
      createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
      xtermFocusMock.mockClear();

      rerender(<Terminal paneId="pswitch-in" cwd="/" workspaceId="ws-switch" isPaneActive />);

      await vi.advanceTimersToNextFrame();

      expect(xtermFocusMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('split keyboard focus callback (xterm focus listener)', () => {
  it('invokes onTerminalPaneFocused with terminalId when the xterm focus listener runs', () => {
    const onPane = vi.fn();
    render(
      <Terminal
        paneId="p-split-focus"
        terminalId="term-a"
        cwd="/"
        workspaceId="ws-sf"
        onTerminalPaneFocused={onPane}
      />,
    );
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
    expect(xtermFocusHandlerRef.current).toBeTypeOf('function');
    xtermFocusHandlerRef.current?.();
    expect(onPane).toHaveBeenCalledWith('term-a');
  });

  it('does not invoke onTerminalPaneFocused when terminalId is omitted', () => {
    const onPane = vi.fn();
    render(
      <Terminal paneId="p-no-tid" cwd="/" workspaceId="ws-sf" onTerminalPaneFocused={onPane} />,
    );
    createOrAttachMutateMock.mock.calls[0]?.[1]?.onSuccess?.({ serializedState: '' });
    xtermFocusHandlerRef.current?.();
    expect(onPane).not.toHaveBeenCalled();
  });
});

describe('terminal theme', () => {
  it('re-initialises with the palette committed since the first mount', () => {
    const { rerender } = render(<Terminal paneId="p-theme-a" cwd="/" workspaceId="ws-t" />);
    const palette: ActivePalette = {
      themeId: 'clay',
      appearance: 'light',
      syntax: 'github-light',
      colors: derivePalette({ background: '#f5f4ed', accent: '#d97857' }),
      stock: false,
      inline: true,
    };
    activePaletteMock.mockReturnValue(palette);

    rerender(<Terminal paneId="p-theme-b" cwd="/" workspaceId="ws-t" />);

    expect(createInstanceMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ initialTheme: getTerminalTheme(true, palette) }),
    );
  });
});
