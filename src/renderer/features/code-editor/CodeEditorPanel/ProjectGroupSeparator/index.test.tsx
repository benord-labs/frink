// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { ProjectGroupSeparator } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

/** `ros-service` was renamed after it was added; `frink`'s chat-1 works in a worktree. */
async function answer(op: Operation) {
  if (op.path === 'projects.list') {
    return [
      { id: 'p1', name: 'frink', path: '/Users/me/code/frink' },
      { id: 'p2', name: 'ROS service', path: '/Users/me/code/ros-service' },
    ];
  }
  if (op.path === 'chats.get') return { project: { id: 'p1', name: 'frink' } };
  throw new Error(`Unexpected test operation: ${op.path}`);
}

describe('ProjectGroupSeparator', () => {
  it('names the group as the project at its folder is registered', async () => {
    renderWithTrpc(
      <ProjectGroupSeparator
        projectPath="/Users/me/code/ros-service/"
        worktreeChatId={undefined}
        folderName="ros-service"
      />,
      answer,
    );

    expect(await screen.findByText('ROS service')).toBeInTheDocument();
  });

  it("names a worktree chat's tabs after the chat's project, not the worktree folder", async () => {
    renderWithTrpc(
      <ProjectGroupSeparator
        projectPath="/Users/me/.frink/worktrees/frink/misty-fjord"
        worktreeChatId="chat-1"
        folderName="misty-fjord"
      />,
      answer,
    );

    expect(await screen.findByText('frink')).toBeInTheDocument();
    expect(screen.queryByText('misty-fjord')).toBeNull();
  });

  it('keeps the folder name for a folder no project is registered at', async () => {
    const asked = vi.fn(answer);
    renderWithTrpc(
      <ProjectGroupSeparator
        projectPath="/Users/me/scratch"
        worktreeChatId={undefined}
        folderName="scratch"
      />,
      asked,
    );

    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    expect(screen.getByText('scratch')).toBeInTheDocument();
    expect(asked.mock.calls.map(([op]) => op.path)).toEqual(['projects.list']);
  });

  // At this size a faded muted-foreground (/60) measures about 2.4:1, below AA's 4.5:1.
  it('draws the name in full-strength muted text', () => {
    renderWithTrpc(
      <ProjectGroupSeparator
        projectPath={undefined}
        worktreeChatId={undefined}
        folderName="Files"
      />,
      answer,
    );

    expect(screen.getByText('Files')).toHaveClass('text-muted-foreground');
  });

  it('names the group of tabs from no project "Files", and asks nothing', () => {
    const asked = vi.fn(answer);
    renderWithTrpc(
      <ProjectGroupSeparator projectPath={undefined} worktreeChatId="chat-1" folderName="Files" />,
      asked,
    );

    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });
});
