// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { GitChangesStatus } from '../../../shared/changes-types';
import { useUncommittedFiles } from './use-uncommitted-files';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const CHANGED_FILES = [{ displayPath: 'a.ts' }, { displayPath: 'b.ts' }, { displayPath: 'c.ts' }];
const STATUS_INPUT = z.object({ worktreePath: z.string() }).strict();
const requestedWorktrees: string[] = [];
let gitStatus: GitChangesStatus = { staged: [], unstaged: [], untracked: [] };

/** Answers changes.getStatus with `gitStatus`, refusing any input beyond the worktree path. */
async function answer(op: Operation): Promise<GitChangesStatus> {
  if (op.path !== 'changes.getStatus') throw new Error(`Unexpected test operation: ${op.path}`);
  requestedWorktrees.push(STATUS_INPUT.parse(op.input).worktreePath);
  return gitStatus;
}

function StatusCard(props: { worktreePath: string | null; isStreaming: boolean }) {
  const files = useUncommittedFiles(CHANGED_FILES, props.worktreePath, props.isStreaming);
  return <span data-testid="files">{files.map((file) => file.displayPath).join(',')}</span>;
}

const shownFiles = () => screen.getByTestId('files').textContent;

afterEach(() => {
  cleanup();
  requestedWorktrees.length = 0;
  gitStatus = { staged: [], unstaged: [], untracked: [] };
});

describe('useUncommittedFiles', () => {
  it('shows every changed file until git status loads, then only the uncommitted ones', async () => {
    gitStatus = {
      staged: [{ path: 'a.ts', status: 'modified' }],
      unstaged: [],
      untracked: [{ path: 'c.ts', status: 'untracked' }],
    };

    renderWithTrpc(<StatusCard worktreePath="/repo" isStreaming={false} />, answer);

    expect(shownFiles()).toBe('a.ts,b.ts,c.ts');
    await waitFor(() => expect(shownFiles()).toBe('a.ts,c.ts'));
    expect(requestedWorktrees).toEqual(['/repo']);
  });

  it('hides every file once git reports a clean tree', async () => {
    renderWithTrpc(<StatusCard worktreePath="/repo" isStreaming={false} />, answer);

    await waitFor(() => expect(shownFiles()).toBe(''));
  });

  it('keeps every changed file while streaming, without asking git', () => {
    renderWithTrpc(<StatusCard worktreePath="/repo" isStreaming />, answer);

    expect(shownFiles()).toBe('a.ts,b.ts,c.ts');
    expect(requestedWorktrees).toEqual([]);
  });

  it('keeps every changed file when the chat has no worktree', () => {
    renderWithTrpc(<StatusCard worktreePath={null} isStreaming={false} />, answer);

    expect(shownFiles()).toBe('a.ts,b.ts,c.ts');
    expect(requestedWorktrees).toEqual([]);
  });
});
