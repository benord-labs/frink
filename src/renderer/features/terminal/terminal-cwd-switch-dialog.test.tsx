// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalCwdSwitchDialog } from './terminal-cwd-switch-dialog';

describe('TerminalCwdSwitchDialog', () => {
  it('renders target cwd and wires primary actions', () => {
    const onMoveDirectory = vi.fn();
    const onKeepCurrent = vi.fn();
    const onDetachTerminal = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <TerminalCwdSwitchDialog
        open={true}
        nextCwd="/next/project"
        onOpenChange={onOpenChange}
        onMoveDirectory={onMoveDirectory}
        onKeepCurrent={onKeepCurrent}
        onDetachTerminal={onDetachTerminal}
      />,
    );

    expect(screen.getByText('/next/project')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Move directory' }));
    expect(onMoveDirectory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Detach terminal' }));
    expect(onDetachTerminal).toHaveBeenCalledTimes(1);
  });

  it('calls keep-current when cancel is clicked', () => {
    const onKeepCurrent = vi.fn();

    render(
      <TerminalCwdSwitchDialog
        open={true}
        nextCwd="/next/project"
        onOpenChange={vi.fn()}
        onMoveDirectory={vi.fn()}
        onKeepCurrent={onKeepCurrent}
        onDetachTerminal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Keep current directory' }));
    expect(onKeepCurrent).toHaveBeenCalledTimes(1);
  });
});
