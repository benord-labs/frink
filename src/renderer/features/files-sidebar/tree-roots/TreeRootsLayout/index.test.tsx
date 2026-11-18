// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { focusChatTree, TreeRootsLayout } from './index';

// Each linked project is an empty folder, so its section shows no rows of its own.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    files: {
      listDirectory: { useQuery: () => ({ data: [] }) },
      search: { useQuery: () => ({ data: [] }) },
      entryType: { useQuery: () => ({ isSuccess: true, data: 'folder' }) },
    },
    changes: { getBranches: { useQuery: () => ({ data: { current: 'main' } }) } },
  },
}));
// A menu renders inline, so a test can pick an item without a right-click.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
}));

const main = { id: 'app', name: 'app', path: '/w/app', workingPath: '/w/app', branch: 'feat' };
const project = (name: string) => ({ id: name, name, path: `/w/${name}`, missing: false });

/** The layout around a stand-in for the chat's tree: a focusable tree holding a text field. An
 *  unlink succeeds after a tick unless `unlink` says it fails then, or never settles. */
function Harness({
  initial,
  chatId = 'chat-1',
  onCreateInMain = () => {},
  unlink = 'succeeds',
}: {
  initial: string[];
  chatId?: string;
  onCreateInMain?: (type: 'file' | 'folder') => void;
  unlink?: 'succeeds' | 'fails' | 'hangs';
}) {
  const [names, setNames] = useState(initial);
  const [expanded, setExpanded] = useState(true);
  const [, setUnlinking] = useState(false);
  // As the real hook does: it renders again as the unlink starts, before the row goes.
  const unlinkProject = (id: string, options?: { onError?: () => void }) => {
    setUnlinking(true);
    if (unlink === 'succeeds') {
      setTimeout(() => setNames((current) => current.filter((name) => name !== id)));
    }
    if (unlink === 'fails') setTimeout(() => options?.onError?.());
  };
  return (
    <TooltipProvider>
      <TreeRootsLayout
        projects={{ main, linked: names.map(project), unlink: unlinkProject }}
        chatId={chatId}
        mainPath="/w/app"
        searchQuery=""
        mainExpanded={expanded}
        onMainExpandedChange={setExpanded}
        onCreateInMain={onCreateInMain}
      >
        <div role="tree" aria-label="app file tree" tabIndex={0}>
          <input aria-label="open folder" />
        </div>
      </TreeRootsLayout>
      <button type="button" onClick={() => setNames((current) => [...current, 'api'])}>
        Link api
      </button>
      {/* Another window unlinks every project, or the chat's links change */}
      <button type="button" onClick={() => setNames([])}>
        Drop all
      </button>
      <input aria-label="composer" />
    </TooltipProvider>
  );
}

const chatTree = () => screen.getByRole('tree', { name: 'app file tree', hidden: true });
const mainRow = () => screen.getByRole('button', { name: /^app Main/, hidden: true });
const rootRow = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name} Linked`) });

afterEach(() => {
  cleanup();
});

describe('TreeRootsLayout', () => {
  it("shows the chat's tree alone with no linked project, and keeps its state once one is linked", () => {
    render(<Harness initial={[]} />);
    fireEvent.change(screen.getByLabelText('open folder'), { target: { value: 'src' } });

    expect(screen.queryByRole('button', { name: /Main/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Linked/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Link api' }));

    expect(screen.getByLabelText('open folder')).toHaveValue('src');
  });

  it("puts Main first, then the chat's tree, then each linked project in order", () => {
    render(<Harness initial={['api', 'web']} />);

    const inOrder = [mainRow(), chatTree(), rootRow('api'), rootRow('web')];
    for (const [index, element] of inOrder.slice(1).entries()) {
      expect(inOrder[index].compareDocumentPosition(element)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    expect(mainRow()).toHaveAccessibleName('app Main on branch feat');
    expect(screen.queryByRole('button', { name: /^Unlink app/ })).not.toBeInTheDocument();
    expect(rootRow('api').parentElement).toContainElement(screen.getByLabelText('Unlink api'));
    fireEvent.focus(mainRow());
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      /^app · MainOn branch featThe working folder, branch, worktree and CLAUDE\.md come from here\.\/w\/app$/,
    );
  });

  it("hides the chat's tree under a closed Main row without unmounting it", async () => {
    render(<Harness initial={['api']} />);
    fireEvent.change(screen.getByLabelText('open folder'), { target: { value: 'src' } });

    await userEvent.click(mainRow());

    expect(mainRow()).toHaveAttribute('aria-expanded', 'false');
    expect(chatTree()).not.toBeVisible();
    expect(rootRow('api')).toBeVisible();
    await userEvent.click(mainRow());
    expect(screen.getByLabelText('open folder')).toHaveValue('src');
  });

  it.each([
    ['the next project', ['api', 'web'], 'api', () => rootRow('web')],
    ['Main after the last project', ['api', 'web'], 'web', mainRow],
    ["the chat's tree once no project is left", ['api'], 'api', chatTree],
  ])(
    'moves focus to %s once the x has unlinked a project',
    async (_, initial, removed, expected) => {
      const user = userEvent.setup();
      render(<Harness initial={initial} />);
      screen.getByRole('button', { name: `Unlink ${removed}` }).focus();

      await user.keyboard('{Enter}');

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: `Unlink ${removed}` })).toBeNull(),
      );
      expect(expected()).toHaveFocus();
    },
  );

  it.each([
    ['fails', 'chat-1'],
    ['is still on its way when the chat changes', 'chat-2'],
  ] as const)('moves no focus later once an unlink %s', async (_, laterChatId) => {
    const user = userEvent.setup();
    const unlink = laterChatId === 'chat-1' ? 'fails' : 'hangs';
    const { rerender } = render(<Harness initial={['api', 'web']} unlink={unlink} />);
    screen.getByRole('button', { name: 'Unlink api' }).focus();
    await user.keyboard('{Enter}');
    // Let a failed unlink report back.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole('button', { name: 'Unlink api' })).toHaveFocus();

    screen.getByLabelText('composer').focus();
    rerender(<Harness initial={['api', 'web']} unlink={unlink} chatId={laterChatId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop all' }));

    expect(screen.queryByRole('button', { name: 'Unlink api' })).toBeNull();
    expect(screen.getByLabelText('composer')).toHaveFocus();
  });

  it("offers New File and New Folder on Main, opening the chat's tree first", async () => {
    const onCreateInMain = vi.fn();
    render(<Harness initial={['api']} onCreateInMain={onCreateInMain} />);
    await userEvent.click(mainRow());
    expect(chatTree()).not.toBeVisible();

    fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder...' }));

    expect(onCreateInMain).toHaveBeenCalledExactlyOnceWith('folder');
    expect(chatTree()).toBeVisible();
  });

  it("focuses the chat's tree, or Main while it has the tree closed", async () => {
    render(<Harness initial={['api']} />);

    focusChatTree(chatTree());
    expect(chatTree()).toHaveFocus();

    await userEvent.click(mainRow());
    rootRow('api').focus();
    focusChatTree(chatTree());
    expect(mainRow()).toHaveFocus();
  });

  it("starts each project's section afresh in another chat", async () => {
    const { rerender } = render(<Harness initial={['api']} />);
    await userEvent.click(rootRow('api'));
    expect(rootRow('api')).toHaveAttribute('aria-expanded', 'false');

    rerender(<Harness initial={['api']} chatId="chat-2" />);

    expect(rootRow('api')).toHaveAttribute('aria-expanded', 'true');
  });
});
