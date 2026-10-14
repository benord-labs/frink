// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileChatHeader } from './mobile-chat-header';

afterEach(cleanup);

const diffStats = { fileCount: 1, additions: 2, deletions: 0, isLoading: false, hasChanges: true };

describe('MobileChatHeader actions', () => {
  it('shows only the projects button when no panel can open', () => {
    render(<MobileChatHeader onBackToChats={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'All projects' })).toBeInTheDocument();
  });

  it('wires terminal, diff and restore to their own callbacks', () => {
    const onOpenTerminal = vi.fn();
    const onOpenDiff = vi.fn();
    const onRestore = vi.fn();
    render(
      <MobileChatHeader
        onBackToChats={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        canOpenTerminal
        onOpenDiff={onOpenDiff}
        canOpenDiff
        diffStats={diffStats}
        isArchived
        onRestore={onRestore}
      />,
    );

    const [, terminal, diff, restore] = screen.getAllByRole('button');
    fireEvent.click(terminal);
    expect(onOpenTerminal).toHaveBeenCalledOnce();
    fireEvent.click(diff);
    expect(onOpenDiff).toHaveBeenCalledOnce();
    fireEvent.click(restore);
    expect(onRestore).toHaveBeenCalledOnce();
    expect(restore).toHaveTextContent('Restore');
  });
});
