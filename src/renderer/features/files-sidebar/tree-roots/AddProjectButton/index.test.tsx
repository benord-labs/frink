// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { chatTreeProjectIdsAtomFamily } from '@/lib/workspace-context/tree-projects';
import { AddProjectButton } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const app = { id: 'app', name: 'app', path: '/w/app' };
const PROJECTS = [
  app,
  { id: 'api', name: 'api', path: '/w/api' },
  { id: 'app-fork', name: 'app', path: '/forks/app' },
];
// Any other id, such as a new-chat pane's 'empty-0', is unknown to chats.get.
const CHATS: Record<string, unknown> = {
  'app-chat': { worktreePath: null, branch: null, project: app },
  'api-chat': { worktreePath: null, branch: null, project: PROJECTS[1] },
  general: { worktreePath: null, branch: null, project: null },
  virtual: {
    worktreePath: null,
    branch: null,
    project: { id: 'ideas', name: 'Ideas', path: 'virtual://ideas' },
  },
};

/** What projects.list waits for; a test can hold it back */
let projectsReady = Promise.resolve();
/** What projects.list answers; a test can add to it */
let projects = PROJECTS;

async function answer(op: Operation): Promise<unknown> {
  if (op.path === 'chats.get') return CHATS[(op.input as { id: string }).id] ?? null;
  if (op.path === 'changes.getBranches') return { current: 'main' };
  if (op.path === 'projects.list') return projectsReady.then(() => projects);
  throw new Error(`Unexpected test operation: ${op.path}`);
}

function renderButtons(chatIds: string[], getMentionTexts?: () => string[]) {
  const store = createStore();
  renderWithTrpc(
    <Provider store={store}>
      <TooltipProvider>
        {chatIds.map((chatId) => (
          <AddProjectButton key={chatId} chatId={chatId} getMentionTexts={getMentionTexts} />
        ))}
      </TooltipProvider>
    </Provider>,
    answer,
  );
  return { store, user: userEvent.setup() };
}

const addButton = () => screen.findByRole('button', { name: 'Add project' });
/** Each listed row's folder, in order */
const rowPaths = () => screen.queryAllByRole('menuitem').map((row) => row.getAttribute('title'));

afterEach(() => {
  cleanup();
  projectsReady = Promise.resolve();
  projects = PROJECTS;
});

describe('AddProjectButton', () => {
  it.each([
    ['a new-chat pane', 'empty-0'],
    ['a general chat', 'general'],
    ['a virtual folder chat', 'virtual'],
  ])('shows nothing for %s', async (_, chatId) => {
    // The project chat lists projects only after both chats load, so this chat has loaded by then.
    const { user } = renderButtons([chatId, 'app-chat']);
    await user.click(await addButton());
    await screen.findByRole('menuitem', { name: 'api' });

    expect(screen.getAllByRole('button', { name: 'Add project' })).toHaveLength(1);
  });

  it("adds the picked project to the chat's tree, offering only the other projects", async () => {
    const { store, user } = renderButtons(['app-chat']);

    await user.click(await addButton());
    const rows = await screen.findAllByRole('menuitem');
    expect(rows.map((row) => row.getAttribute('title'))).toEqual(['/w/api', '/forks/app']);
    // The other 'app' shows its folder, to tell it from the chat's own project
    expect(within(rows[1]).getByText('forks')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      /^Only changes this chat's file tree\. The chat, its agent and its branch stay on app\.$/,
    );
    await user.click(screen.getByRole('menuitem', { name: 'api' }));

    expect(store.get(chatTreeProjectIdsAtomFamily('app-chat'))).toEqual(['api']);
  });

  it("reads the chat's messages each time the list opens, and lists the projects they name first", async () => {
    let loadProjects = () => {};
    projectsReady = new Promise((resolve) => (loadProjects = resolve));
    const getMentionTexts = vi.fn(() => ['Fixed /forks/app/src/x.ts']);
    const { user } = renderButtons(['app-chat'], getMentionTexts);

    const button = await addButton();
    expect(getMentionTexts).not.toHaveBeenCalled();
    await user.click(button);
    // The projects that finish loading after the list opens are matched too.
    await screen.findByText('Loading projects…');
    loadProjects();
    const mentioned = await screen.findByRole('menuitem', { name: /Mentioned in this chat/ });
    expect(screen.getAllByRole('menuitem')).toEqual([mentioned, expect.anything()]);
    expect(mentioned).toHaveAttribute('title', '/forks/app');
    expect(getMentionTexts).toHaveBeenCalledOnce();

    await user.keyboard('{Escape}');
    await user.click(button);
    expect(getMentionTexts).toHaveBeenCalledTimes(2);
  });

  it('marks only the deepest project a message names, also once that project is in the tree', async () => {
    projects = [...PROJECTS, { id: 'api-lib', name: 'lib', path: '/w/api/lib' }];
    const { user } = renderButtons(['app-chat'], () => ['Fixed /w/api/lib/x.ts']);

    await user.click(await addButton());
    await user.click(await screen.findByRole('menuitem', { name: 'lib Mentioned in this chat' }));
    await user.click(await addButton());
    await screen.findAllByRole('menuitem');

    // The project around it isn't marked in its place
    expect(rowPaths()).toEqual(['/w/api', '/forks/app']);
    expect(screen.queryByText('Mentioned in this chat')).not.toBeInTheDocument();
  });

  it('never marks projects for another chat with the messages read for the first', async () => {
    const store = createStore();
    const ui = (chatId: string) => (
      <Provider store={store}>
        <TooltipProvider>
          <AddProjectButton
            key="pane"
            chatId={chatId}
            getMentionTexts={() => ['Fixed /forks/app/src/x.ts']}
          />
          {/* Loads the next chat first, so switching to it keeps the open list open */}
          <AddProjectButton key="seen" chatId="api-chat" />
        </TooltipProvider>
      </Provider>
    );
    const { rerender } = renderWithTrpc(ui('app-chat'), answer);
    const [button] = await screen.findAllByRole('button', { name: 'Add project' });
    await userEvent.setup().click(button);
    await screen.findByRole('menuitem', { name: /Mentioned in this chat/ });

    rerender(ui('api-chat'));

    await waitFor(() => expect(rowPaths()).toEqual(['/w/app', '/forks/app']));
    expect(screen.queryByText('Mentioned in this chat')).not.toBeInTheDocument();
  });

  it('is named Add project and explains itself in a tooltip', async () => {
    renderButtons(['app-chat']);

    fireEvent.focus(await addButton());

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Add another project to this tree to browse its files',
    );
  });
});
