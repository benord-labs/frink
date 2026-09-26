// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeNode } from '../types';
import { SelectionActionsContext, SelectionStateContext } from './MultiSelectContext';
import { ModifiedFilterContext } from './modified-filter-context';
import { RefreshContext } from './RefreshContext';
import { TreeNode } from './TreeNode';
import { NOOP_SELECTION_STORE } from './use-multi-select';

/**
 * The per-folder context menu is the third site binding useContextMenuFocusHandoff, and the
 * only menu carrying non-create items — so it is the only place the "non-create actions still
 * restore focus" half of the contract can be exercised.
 *
 * The mock set below is TreeNode.test.tsx's, minus the two modules under test: the Radix
 * context menu and the focus handoff hook both run for real here.
 */

const mocks = vi.hoisted(() => ({
  listDirectoryQuery: vi.fn(),
  getShortcutAction: vi.fn(),
  keysToDisplay: vi.fn(),
  openInFinderMutate: vi.fn(),
}));

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    isDragging: false,
  }),
  useDroppable: () => ({
    setNodeRef: () => {},
    isOver: false,
  }),
}));

vi.mock('@/lib/hotkeys/shortcut-registry', () => ({
  getShortcutAction: mocks.getShortcutAction,
  keysToDisplay: mocks.keysToDisplay,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    external: {
      openInFinder: {
        useMutation: () => ({ mutate: mocks.openInFinderMutate }),
      },
    },
  },
  trpcClient: {
    files: {
      listDirectory: {
        query: mocks.listDirectoryQuery,
      },
    },
  },
}));

vi.mock('@/lib/utils/platform', () => ({
  getRevealLabel: () => 'Reveal in Finder',
}));

vi.mock('../../agents/mentions/agents-file-mention', () => ({
  getFileIconByExtension: () => null,
}));

const folderNode: FileTreeNode = {
  id: 'src/components',
  name: 'components',
  path: 'src/components',
  type: 'folder',
  childrenLoaded: false,
};

type CreatingItem = { parentFolder: string; type: 'file' | 'folder' } | null;

/** Mirrors how FileTree owns creatingItem state on behalf of its nodes. */
function Harness({ onInputBlur }: { onInputBlur?: () => void }) {
  const [creatingItem, setCreatingItem] = useState<CreatingItem>(null);
  return (
    <ModifiedFilterContext.Provider value={false}>
      <RefreshContext.Provider value={0}>
        <SelectionActionsContext.Provider value={{}}>
          <SelectionStateContext.Provider value={NOOP_SELECTION_STORE}>
            <div onBlurCapture={onInputBlur}>
              <TreeNode
                node={folderNode}
                level={0}
                projectPath="/tmp/proj"
                onFileClick={vi.fn()}
                onCreateItem={(parentFolder, type) => setCreatingItem({ parentFolder, type })}
                creatingItem={creatingItem}
                onInlineConfirm={() => setCreatingItem(null)}
                onInlineCancel={() => setCreatingItem(null)}
                pathToExpandAfterDrop={null}
              />
            </div>
          </SelectionStateContext.Provider>
        </SelectionActionsContext.Provider>
      </RefreshContext.Provider>
    </ModifiedFilterContext.Provider>
  );
}

function folderRow() {
  const row = document.querySelector('[data-tree-path="src/components"]');
  if (!(row instanceof HTMLElement)) throw new Error('folder row not rendered');
  return row;
}

async function openFolderMenuAndSelect(item: RegExp) {
  const user = userEvent.setup();
  await user.pointer({ keys: '[MouseRight]', target: folderRow() });
  await user.click(await screen.findByText(item));
  return user;
}

beforeEach(() => {
  mocks.getShortcutAction.mockReset().mockReturnValue(null);
  mocks.keysToDisplay.mockReset().mockReturnValue('');
  mocks.openInFinderMutate.mockReset();
  // Resolve empty so the pending fetch cannot settle mid-assertion; the children group
  // renders on creatingItem alone, so the inline input does not depend on it.
  mocks.listDirectoryQuery.mockReset().mockResolvedValue([]);
});

describe('TreeNode create focus handoff', () => {
  it('expands the folder and focuses the inline input after New File', async () => {
    render(<Harness />);
    await openFolderMenuAndSelect(/New File/);

    expect(folderRow()).toHaveAttribute('aria-expanded', 'true');
    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('focuses the inline input after New Folder', async () => {
    render(<Harness />);
    await openFolderMenuAndSelect(/New Folder/);

    const input = await screen.findByLabelText('New folder name');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('accepts typing immediately, so the first keystrokes are not lost', async () => {
    render(<Harness />);
    const user = await openFolderMenuAndSelect(/New File/);

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard('notes.md');
    expect(input).toHaveValue('notes.md');
  });

  it('keeps the inline input mounted through the menu-dismiss gesture', async () => {
    // InlineInput dismisses on outside click; the selecting gesture must not count as one.
    render(<Harness />);
    await openFolderMenuAndSelect(/New File/);

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toBeInTheDocument();
  });
});

describe('TreeNode non-create focus restore', () => {
  it('restores focus to the folder row after a non-create action', async () => {
    render(<Harness />);
    await openFolderMenuAndSelect(/Reveal in Finder/);

    expect(mocks.openInFinderMutate).toHaveBeenCalled();
    // No handoff was marked, so Radix's default close behaviour must return focus to the
    // trigger rather than stranding it on the body.
    await waitFor(() => expect(folderRow()).toHaveFocus());
  });

  it('does not let a consumed create flag swallow the next restore', async () => {
    // The handoff flag is one-shot. If a create leaked it, the following non-create close
    // would suppress the restore and focus would be stranded.
    render(<Harness />);
    const user = await openFolderMenuAndSelect(/New File/);

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard('{Escape}');

    await openFolderMenuAndSelect(/Reveal in Finder/);
    await waitFor(() => expect(folderRow()).toHaveFocus());
  });
});
