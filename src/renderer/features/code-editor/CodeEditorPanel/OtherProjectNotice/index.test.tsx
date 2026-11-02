// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { OtherProjectNotice } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

const browsedTab = { projectPath: '/Users/me/code/ros-service/', isOtherProject: true };

function answerProjects(projects: Array<{ id: string; name: string; path: string }>) {
  return async (op: Operation) => {
    if (op.path !== 'projects.list') throw new Error(`Unexpected test operation: ${op.path}`);
    return projects;
  };
}

describe('OtherProjectNotice', () => {
  it('names the registered project the tab is from', async () => {
    renderWithTrpc(
      <OtherProjectNotice file={browsedTab} />,
      answerProjects([
        { id: 'p1', name: 'frink', path: '/Users/me/code/frink' },
        { id: 'p2', name: 'ROS service', path: '/Users/me/code/ros-service' },
      ]),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      "You're browsing ROS service. Browsing doesn't change what the agent can read.",
    );
  });

  it('falls back to the folder name for a folder no project is registered at', async () => {
    renderWithTrpc(<OtherProjectNotice file={browsedTab} />, answerProjects([]));

    expect(await screen.findByRole('status')).toHaveTextContent(
      "You're browsing ros-service. Browsing doesn't change what the agent can read.",
    );
  });

  it('falls back to the folder name of a Windows path', async () => {
    renderWithTrpc(
      <OtherProjectNotice
        file={{ projectPath: 'C:\\Users\\me\\ros-service\\', isOtherProject: true }}
      />,
      answerProjects([]),
    );

    expect(await screen.findByRole('status')).toHaveTextContent("You're browsing ros-service.");
  });

  it('falls back to the folder name when the project list fails', async () => {
    renderWithTrpc(<OtherProjectNotice file={browsedTab} />, async () => {
      throw new Error('database closed');
    });

    expect(await screen.findByRole('status')).toHaveTextContent("You're browsing ros-service.");
  });

  it('shows nothing while the project list loads', async () => {
    const answer = vi.fn(() => new Promise<never>(() => undefined));
    renderWithTrpc(<OtherProjectNotice file={browsedTab} />, answer);

    await vi.waitFor(() => expect(answer).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("shows nothing for a tab from the chat's own project, or no tab", () => {
    const answer = vi.fn(answerProjects([]));
    const { rerender } = renderWithTrpc(
      <OtherProjectNotice file={{ projectPath: '/Users/me/code/frink' }} />,
      answer,
    );
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<OtherProjectNotice file={null} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });
});
