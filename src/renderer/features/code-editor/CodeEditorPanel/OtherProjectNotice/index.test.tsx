// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { trpc } from '@/lib/trpc';
import { OtherProjectNotice } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const frink = { id: 'p1', name: 'frink', path: '/Users/me/code/frink' };
const ros = { id: 'p2', name: 'ROS service', path: '/Users/me/code/ros-service' };
const browsedTab = { projectPath: '/Users/me/code/ros-service/', isOtherProject: true };
const linkedRos = { ...ros, missing: false };
/** What each chat links. frink-chat and pane-b work in frink; a general chat links nothing. */
let linked: Record<string, object[]> = {};
/** Set to hold every chats.get answer back */
let holdChats = false;

afterEach(() => {
  cleanup();
  linked = {};
  holdChats = false;
});

function answerProjects(projects: Array<{ id: string; name: string; path: string }>) {
  return async (op: Operation) => {
    const { id = '', chatId = '' } = (op.input ?? {}) as { id?: string; chatId?: string };
    if (op.path === 'projects.list') return projects;
    if (op.path === 'changes.getBranches') return { current: 'main' };
    if (op.path === 'chats.get') {
      if (holdChats) return new Promise(() => {});
      const project = ['frink-chat', 'pane-b'].includes(id) ? frink : null;
      return { worktreePath: null, branch: null, project, linkedProjects: linked[id] ?? [] };
    }
    if (op.path !== 'chats.linkProject') throw new Error(`Unexpected test operation: ${op.path}`);
    linked[chatId] = [linkedRos];
    return { success: true };
  };
}

/** Renders `ui`, recording the links it asks for. */
function renderNotice(ui: ReactElement, answer: (op: Operation) => Promise<unknown>) {
  const asked = vi.fn(answer);
  renderWithTrpc(ui, asked);
  return { linkCalls: () => asked.mock.calls.filter(([op]) => op.path === 'chats.linkProject') };
}

const LINK_IT = 'Link it to let the agent read files here without asking.';
const NOT_LINKED = "ROS service isn't linked to this chat.";
const LINKED = 'ROS service is linked to this chat. The agent can read files here without asking.';

describe('OtherProjectNotice', () => {
  it.each([
    ['a tab no chat opened', undefined, 'frink-chat', {}, NOT_LINKED],
    ['a general chat', 'general', 'general', {}, NOT_LINKED],
    ['a chat that links it', 'frink-chat', 'frink-chat', { 'frink-chat': [linkedRos] }, LINKED],
    ['a chat that can link it', 'frink-chat', 'frink-chat', {}, `${NOT_LINKED} ${LINK_IT}`],
    // The tab stays open over a new-chat form, which links nothing and offers no link.
    ['a new chat', 'frink-chat', null, { 'frink-chat': [linkedRos] }, NOT_LINKED],
    // Split view: pane B is active over a tab pane A's chat opened. B could link it, but the
    // button would link a chat that didn't open the tab.
    ["another pane's chat that can link it", 'frink-chat', 'pane-b', {}, NOT_LINKED],
    [
      "another pane's chat that links it",
      'frink-chat',
      'pane-b',
      { 'pane-b': [linkedRos] },
      LINKED,
    ],
  ])(
    'names the project and says whether %s links it',
    async (_, sourceChatId, chatId, links, text) => {
      linked = links;
      const { linkCalls } = renderNotice(
        <OtherProjectNotice file={{ ...browsedTab, sourceChatId }} chatId={chatId} />,
        answerProjects([frink, ros]),
      );

      expect(await screen.findByRole('status')).toHaveTextContent(new RegExp(`^${text}$`));
      expect(Boolean(screen.queryByRole('button', { name: 'Link project' }))).toBe(
        text.endsWith(LINK_IT),
      );
      expect(linkCalls()).toEqual([]);
    },
  );

  it("links the project to the tab's chat from its Link project button, then focuses the notice", async () => {
    const { linkCalls } = renderNotice(
      <OtherProjectNotice
        file={{ ...browsedTab, sourceChatId: 'frink-chat' }}
        chatId="frink-chat"
      />,
      answerProjects([frink, ros]),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Link project' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(LINKED));
    expect(screen.queryByRole('button', { name: 'Link project' })).toBeNull();
    expect(linkCalls().map(([op]) => op.input)).toEqual([
      { chatId: 'frink-chat', projectId: 'p2' },
    ]);
    expect(screen.getByRole('status')).toHaveFocus();
  });

  it('shows nothing until the chat on screen says what it links', async () => {
    holdChats = true;
    // Shares the notice's project list, so it shows once the notice has that list too.
    function ListProbe() {
      return trpc.projects.list.useQuery().data ? <span>listed</span> : null;
    }
    renderNotice(
      <>
        <ListProbe />
        <OtherProjectNotice
          file={{ ...browsedTab, sourceChatId: 'frink-chat' }}
          chatId="frink-chat"
        />
      </>,
      answerProjects([frink, ros]),
    );

    await screen.findByText('listed');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('falls back to the folder name for a folder no project is registered at', async () => {
    renderNotice(<OtherProjectNotice file={browsedTab} chatId={null} />, answerProjects([]));

    expect(await screen.findByRole('status')).toHaveTextContent(
      /^ros-service isn't linked to this chat\.$/,
    );
  });

  it('falls back to the folder name of a Windows path', async () => {
    renderNotice(
      <OtherProjectNotice
        file={{ projectPath: 'C:\\Users\\me\\ros-service\\', isOtherProject: true }}
        chatId={null}
      />,
      answerProjects([]),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(/^ros-service isn't linked/);
  });

  it('falls back to the folder name when the project list fails', async () => {
    renderNotice(<OtherProjectNotice file={browsedTab} chatId={null} />, async () => {
      throw new Error('database closed');
    });

    expect(await screen.findByRole('status')).toHaveTextContent(/^ros-service isn't linked/);
  });

  it('shows nothing while the project list loads', async () => {
    const answer = vi.fn(() => new Promise<never>(() => undefined));
    renderNotice(<OtherProjectNotice file={browsedTab} chatId={null} />, answer);

    await vi.waitFor(() => expect(answer).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("shows nothing for a tab from the chat's own project, or no tab", () => {
    const answer = vi.fn(answerProjects([]));
    const { rerender } = renderWithTrpc(
      <OtherProjectNotice file={{ projectPath: '/Users/me/code/frink' }} chatId="frink-chat" />,
      answer,
    );
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<OtherProjectNotice file={null} chatId="frink-chat" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });
});
