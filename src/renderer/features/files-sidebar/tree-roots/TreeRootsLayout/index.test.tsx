// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { focusChatTree, TreeRootsLayout } from './index';

// Each added project is an empty folder, so its section shows no rows of its own.
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
const project = (name: string) => ({ id: name, name, path: `/w/${name}` });

/** The layout around a stand-in for the chat's tree: a focusable tree holding a text field. */
function Harness({
  initial,
  chatId = 'chat-1',
  onCreateInMain = () => {},
}: {
  initial: string[];
  chatId?: string;
  onCreateInMain?: (type: 'file' | 'folder') => void;
}) {
  const [names, setNames] = useState(initial);
  const [expanded, setExpanded] = useState(true);
  const remove = (id: string) => setNames((current) => current.filter((name) => name !== id));
  return (
    <TooltipProvider>
      <TreeRootsLayout
        projects={{ main, extras: names.map(project), remove }}
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
        Add api
      </button>
    </TooltipProvider>
  );
}

const chatTree = () => screen.getByRole('tree', { name: 'app file tree', hidden: true });
const thisChatRow = () => screen.getByRole('button', { name: /^app This chat/, hidden: true });
const rootRow = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name} Browsing`) });

afterEach(() => {
  cleanup();
});

describe('TreeRootsLayout', () => {
  it("shows the chat's tree alone with no other project, and keeps its state once one is added", () => {
    render(<Harness initial={[]} />);
    fireEvent.change(screen.getByLabelText('open folder'), { target: { value: 'src' } });

    expect(screen.queryByRole('button', { name: /This chat/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Browsing/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add api' }));

    expect(screen.getByLabelText('open folder')).toHaveValue('src');
  });

  it("puts This chat first, then the chat's tree, then each project in the order added", () => {
    render(<Harness initial={['api', 'web']} />);

    const inOrder = [thisChatRow(), chatTree(), rootRow('api'), rootRow('web')];
    for (const [index, element] of inOrder.slice(1).entries()) {
      expect(inOrder[index].compareDocumentPosition(element)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    expect(thisChatRow()).toHaveAccessibleName('app This chat on branch feat');
    expect(screen.queryByRole('button', { name: /^Remove app/ })).not.toBeInTheDocument();
  });

  it("hides the chat's tree under a closed This chat row without unmounting it", async () => {
    render(<Harness initial={['api']} />);
    fireEvent.change(screen.getByLabelText('open folder'), { target: { value: 'src' } });

    await userEvent.click(thisChatRow());

    expect(thisChatRow()).toHaveAttribute('aria-expanded', 'false');
    expect(chatTree()).not.toBeVisible();
    expect(rootRow('api')).toBeVisible();
    await userEvent.click(thisChatRow());
    expect(screen.getByLabelText('open folder')).toHaveValue('src');
  });

  it.each([
    ['the next project', ['api', 'web'], 'api', () => rootRow('web')],
    ['This chat after the last project', ['api', 'web'], 'web', thisChatRow],
    ["the chat's tree once no project is left", ['api'], 'api', chatTree],
  ])('moves focus to %s when the x removes a project', async (_, initial, removed, expected) => {
    const user = userEvent.setup();
    render(<Harness initial={initial} />);
    screen.getByRole('button', { name: `Remove ${removed} from this tree` }).focus();

    await user.keyboard('{Enter}');

    expect(screen.queryByRole('button', { name: `Remove ${removed} from this tree` })).toBeNull();
    expect(expected()).toHaveFocus();
  });

  it("offers New File and New Folder on This chat, opening the chat's tree first", async () => {
    const onCreateInMain = vi.fn();
    render(<Harness initial={['api']} onCreateInMain={onCreateInMain} />);
    await userEvent.click(thisChatRow());
    expect(chatTree()).not.toBeVisible();

    fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder...' }));

    expect(onCreateInMain).toHaveBeenCalledExactlyOnceWith('folder');
    expect(chatTree()).toBeVisible();
  });

  it("focuses the chat's tree, or This chat while it has the tree closed", async () => {
    render(<Harness initial={['api']} />);

    focusChatTree(chatTree());
    expect(chatTree()).toHaveFocus();

    await userEvent.click(thisChatRow());
    rootRow('api').focus();
    focusChatTree(chatTree());
    expect(thisChatRow()).toHaveFocus();
  });

  it("starts each project's section afresh in another chat", async () => {
    const { rerender } = render(<Harness initial={['api']} />);
    await userEvent.click(rootRow('api'));
    expect(rootRow('api')).toHaveAttribute('aria-expanded', 'false');

    rerender(<Harness initial={['api']} chatId="chat-2" />);

    expect(rootRow('api')).toHaveAttribute('aria-expanded', 'true');
  });
});
