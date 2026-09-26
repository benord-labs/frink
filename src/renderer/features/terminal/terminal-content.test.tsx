// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalContent } from './terminal-content';
import type { TerminalInstance } from './types';

vi.mock('./terminal', () => ({
  Terminal: ({
    paneId,
    terminalId,
    isKeyboardTarget,
    isPaneActive,
    onTerminalPaneFocused,
  }: {
    paneId: string;
    terminalId?: string;
    isKeyboardTarget?: boolean;
    isPaneActive?: boolean;
    onTerminalPaneFocused?: (id: string) => void;
  }) => (
    <div
      data-testid={`mock-terminal-${paneId}`}
      data-terminal-id={terminalId}
      data-keyboard={isKeyboardTarget === false ? 'off' : 'on'}
      data-pane-active={isPaneActive === false ? 'off' : 'on'}
      data-has-on-terminal-pane-focused={onTerminalPaneFocused != null ? 'true' : 'false'}
    />
  ),
}));

function inst(id: string, pane: string): TerminalInstance {
  return { id, paneId: pane, name: id, createdAt: 0 };
}

describe('TerminalContent', () => {
  afterEach(() => {
    cleanup();
  });

  it('mounts a single terminal when fewer than two split panes', () => {
    const active = inst('a', 'pane-a');
    render(
      <TerminalContent
        activeTerminal={active}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(screen.getByTestId('mock-terminal-pane-a')).toBeTruthy();
  });

  it('renders the active tab session when split columns are suppressed (group dormant, other tab selected)', () => {
    const active = inst('c', 'pane-c');
    render(
      <TerminalContent
        activeTerminal={active}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="c"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(screen.getByTestId('mock-terminal-pane-c')).toBeTruthy();
    expect(screen.queryByTestId('mock-terminal-pane-a')).toBeNull();
  });

  it('mounts N terminals when split pane list has two or more sessions', () => {
    const left = inst('a', 'pane-a');
    const mid = inst('b', 'pane-b');
    const right = inst('c', 'pane-c');
    render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, mid, right]}
        terminalKeyboardTargetId="b"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(screen.getAllByTestId('mock-terminal-pane-a')).toHaveLength(1);
    expect(screen.getAllByTestId('mock-terminal-pane-b')).toHaveLength(1);
    expect(screen.getAllByTestId('mock-terminal-pane-c')).toHaveLength(1);
    expect(screen.getByTestId('mock-terminal-pane-b').getAttribute('data-keyboard')).toBe('on');
    expect(screen.getByTestId('mock-terminal-pane-a').getAttribute('data-keyboard')).toBe('off');
  });

  it('sets data-terminal-id on each split pane wrapper for stable focus routing', () => {
    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        onCloseSplitPane={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(screen.getByTestId('terminal-pane-wrapper-a').getAttribute('data-terminal-id')).toBe(
      'a',
    );
    expect(screen.getByTestId('terminal-pane-wrapper-b').getAttribute('data-terminal-id')).toBe(
      'b',
    );
  });

  it('does not pass onTerminalPaneFocused to Terminal (split uses wrapper only; single never had it)', () => {
    const single = inst('solo', 'pane-solo');
    const { rerender } = render(
      <TerminalContent
        activeTerminal={single}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="solo"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(
      screen
        .getByTestId('mock-terminal-pane-solo')
        .getAttribute('data-has-on-terminal-pane-focused'),
    ).toBe('false');

    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    rerender(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        onCloseSplitPane={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(
      screen.getByTestId('mock-terminal-pane-a').getAttribute('data-has-on-terminal-pane-focused'),
    ).toBe('false');
    expect(
      screen.getByTestId('mock-terminal-pane-b').getAttribute('data-has-on-terminal-pane-focused'),
    ).toBe('false');
  });

  it('calls onTerminalPaneFocused when a pane wrapper receives focus', () => {
    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    const onPane = vi.fn();
    render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={onPane}
        onCloseSplitPane={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    const rightPane = screen.getByTestId('terminal-pane-wrapper-b');
    fireEvent.focus(rightPane);
    expect(onPane).toHaveBeenCalledWith('b');
  });

  it('does not call onTerminalPaneFocused on mouseDown alone (focus handler owns routing)', () => {
    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    const onPane = vi.fn();
    render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={onPane}
        onCloseSplitPane={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    fireEvent.mouseDown(screen.getByTestId('terminal-pane-wrapper-b'));
    expect(onPane).not.toHaveBeenCalled();
  });

  it('does not set inert when isPaneActive is explicitly true', () => {
    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    const { container } = render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        onCloseSplitPane={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
        isPaneActive
      />,
    );
    expect(container.querySelector('[inert]')).toBeNull();
  });

  it('shows loading status with live region when terminal render is deferred', () => {
    render(
      <TerminalContent
        activeTerminal={inst('a', 'pane-a')}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal={false}
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Starting terminal');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('forwards isPaneActive to Terminal', () => {
    const active = inst('a', 'pane-a');
    render(
      <TerminalContent
        activeTerminal={active}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
        isPaneActive={false}
      />,
    );
    expect(screen.getByTestId('mock-terminal-pane-a').getAttribute('data-pane-active')).toBe('off');
  });

  it('sets inert on the terminal interaction surface when split-chat pane is inactive', () => {
    const active = inst('a', 'pane-a');
    const { container } = render(
      <TerminalContent
        activeTerminal={active}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
        isPaneActive={false}
      />,
    );
    expect(container.querySelector('[inert]')).toBeTruthy();
  });

  it('does not set inert when split-chat pane is active', () => {
    const active = inst('a', 'pane-a');
    const { container } = render(
      <TerminalContent
        activeTerminal={active}
        splitPaneTerminals={[]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    expect(container.querySelector('[inert]')).toBeNull();
  });

  it('forwards isPaneActive to each split PTY column', () => {
    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        onCloseSplitPane={vi.fn()}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
        isPaneActive={false}
      />,
    );
    expect(screen.getByTestId('mock-terminal-pane-a').getAttribute('data-pane-active')).toBe('off');
    expect(screen.getByTestId('mock-terminal-pane-b').getAttribute('data-pane-active')).toBe('off');
  });

  it('calls onCloseSplitPane when pane close is clicked', () => {
    const left = inst('a', 'pane-a');
    const right = inst('b', 'pane-b');
    const onClose = vi.fn();
    render(
      <TerminalContent
        activeTerminal={left}
        splitPaneTerminals={[left, right]}
        terminalKeyboardTargetId="a"
        onTerminalPaneFocused={vi.fn()}
        onCloseSplitPane={onClose}
        canRenderTerminal
        terminalBg="#000"
        cwd="/"
        workspaceId="ws"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal pane a' }));
    expect(onClose).toHaveBeenCalledWith('a');
  });
});
