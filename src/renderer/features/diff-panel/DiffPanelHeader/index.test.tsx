// @vitest-environment happy-dom
import { cleanup, screen } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { DiffPanelHeader } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const requested: string[] = [];

/** Answers the header's two queries; listing every branch is not one of them. */
async function answer(op: Operation) {
  requested.push(op.path);
  if (op.path === 'changes.getStatus') {
    return { branch: 'feature/x', staged: [], unstaged: [], untracked: [] };
  }
  if (op.path === 'changes.getGitHubStatus') return null;
  throw new Error(`Unexpected test operation: ${op.path}`);
}

afterEach(() => {
  cleanup();
  requested.length = 0;
});

describe('DiffPanelHeader', () => {
  it('shows the branch git status reports, without listing every branch', async () => {
    renderWithTrpc(
      <TooltipProvider>
        <DiffPanelHeader
          worktreePath="/repo"
          hasChanges={false}
          allCollapsed={false}
          onToggleAllCollapsed={() => undefined}
          onClose={() => undefined}
        />
      </TooltipProvider>,
      answer,
    );

    expect((await screen.findByText('feature/x')).textContent).toBe('feature/x');
    expect(requested).not.toContain('changes.getBranches');
  });
});
