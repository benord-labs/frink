// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchivedChatsSection } from './index';

vi.mock('../../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

const TWO_CHATS = [
  { id: 'chat-1', name: 'Alpha' },
  { id: 'chat-2', name: 'beta' },
];

function renderSection(
  props: Partial<React.ComponentProps<typeof ArchivedChatsSection>> = {},
): void {
  render(
    <ArchivedChatsSection
      archivedChats={[]}
      searchQuery=""
      selectedChatId={null}
      onChatSelect={vi.fn()}
      onChatRestore={vi.fn()}
      onChatDelete={vi.fn()}
      {...props}
    />,
  );
}

function renderSectionForRerender(
  props: Partial<React.ComponentProps<typeof ArchivedChatsSection>> = {},
) {
  const base = {
    archivedChats: [],
    searchQuery: '',
    selectedChatId: null,
    onChatSelect: vi.fn(),
    onChatRestore: vi.fn(),
    onChatDelete: vi.fn(),
  } satisfies React.ComponentProps<typeof ArchivedChatsSection>;
  const view = render(<ArchivedChatsSection {...base} {...props} />);
  return {
    rerender: (next: Partial<React.ComponentProps<typeof ArchivedChatsSection>>) =>
      view.rerender(<ArchivedChatsSection {...base} {...props} {...next} />),
  };
}

describe('ArchivedChatsSection', () => {
  it('shows empty state when archived mode is on with no chats', () => {
    renderSection();

    expect(screen.getByText('Archived (0)')).toBeTruthy();
    expect(screen.getByText('No archived chats yet')).toBeTruthy();
  });

  it('calls restore handler for a chat row', () => {
    const onChatRestore = vi.fn();
    const onChatSelect = vi.fn();
    renderSection({
      archivedChats: [{ id: 'chat-1', name: 'hello' }],
      onChatSelect,
      onChatRestore,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Restore hello' }));
    expect(onChatRestore).toHaveBeenCalledWith('chat-1');

    fireEvent.click(screen.getByRole('treeitem', { name: 'hello' }));
    expect(onChatSelect).toHaveBeenCalledWith('chat-1');
  });

  it('filters rows by name, case-insensitively', () => {
    renderSection({ archivedChats: TWO_CHATS, searchQuery: 'AL' });

    expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'beta' })).toBeNull();
  });

  // The count is the archive total, not the match count, so it agrees with the
  // footer badge rendered a few pixels away.
  it('keeps the header count at the archive total while filtering', () => {
    renderSection({ archivedChats: TWO_CHATS, searchQuery: 'AL' });

    expect(screen.getByText('Archived (2)')).toBeTruthy();
  });

  it('distinguishes a no-match state from an empty archive', () => {
    renderSection({ archivedChats: TWO_CHATS, searchQuery: 'zzz' });

    expect(screen.getByText('No matches found')).toBeTruthy();
    expect(screen.queryByText('No archived chats yet')).toBeNull();
  });

  it('treats a whitespace-only query as no filter', () => {
    renderSection({ archivedChats: TWO_CHATS, searchQuery: '   ' });

    expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'beta' })).toBeTruthy();
  });

  // Matching is on the stored name, not the rendered "Untitled chat" fallback,
  // so an unnamed chat never surfaces for a query that merely matches the label.
  it('excludes unnamed chats once a query is set', () => {
    const withUnnamed = [{ id: 'chat-3', name: null }, ...TWO_CHATS];

    renderSection({ archivedChats: withUnnamed, searchQuery: '' });
    expect(screen.getByRole('treeitem', { name: 'Untitled chat' })).toBeTruthy();
    cleanup();

    renderSection({ archivedChats: withUnnamed, searchQuery: 'untitled' });
    expect(screen.queryByRole('treeitem', { name: 'Untitled chat' })).toBeNull();
    expect(screen.getByText('No matches found')).toBeTruthy();
  });

  it('ignores whitespace padding around a real query', () => {
    renderSection({ archivedChats: TWO_CHATS, searchQuery: '  al  ' });

    expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'beta' })).toBeNull();
  });

  // Chat names routinely carry branch-ish punctuation, so the query is a literal
  // substring, never a pattern -- "sc-1." must not behave like a wildcard.
  it('treats regex metacharacters as literal text', () => {
    const punctuated = [
      { id: 'chat-a', name: 'fix(sidebar): sc-198' },
      { id: 'chat-b', name: 'fixXsidebarY' },
    ];

    renderSection({ archivedChats: punctuated, searchQuery: 'fix(sidebar)' });
    expect(screen.getByRole('treeitem', { name: 'fix(sidebar): sc-198' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'fixXsidebarY' })).toBeNull();

    cleanup();
    renderSection({ archivedChats: punctuated, searchQuery: 'fix.sidebar.' });
    expect(screen.getByText('No matches found')).toBeTruthy();
  });

  it('preserves source order when filtering', () => {
    renderSection({ archivedChats: TWO_CHATS, searchQuery: 'a' });

    const names = screen.getAllByRole('treeitem').map((row) => row.textContent);
    expect(names).toEqual(['Alpha', 'beta']);
  });
});

// The confirm dialog is the only thing standing between a hover click and an irreversible
// delete, so these render the real AlertDialog rather than a pass-through mock.
describe('ArchivedChatsSection delete', () => {
  it('exposes a delete control per row', () => {
    renderSection({ archivedChats: TWO_CHATS });

    expect(screen.getByRole('button', { name: 'Delete Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete beta' })).toBeInTheDocument();
  });

  it('confirms before deleting rather than firing on the icon click', () => {
    const onChatDelete = vi.fn();
    renderSection({
      archivedChats: [{ id: 'chat-1', name: 'hello' }],
      onChatDelete,
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete hello' }));

    expect(onChatDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Delete "hello" permanently?')).toBeInTheDocument();
  });

  it('deletes the chosen chat once confirmed', () => {
    const onChatDelete = vi.fn();
    renderSection({ archivedChats: TWO_CHATS, onChatDelete });

    fireEvent.click(screen.getByRole('button', { name: 'Delete beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onChatDelete).toHaveBeenCalledWith('chat-2');
  });

  it('does not delete when the confirmation is dismissed', () => {
    const onChatDelete = vi.fn();
    renderSection({ archivedChats: TWO_CHATS, onChatDelete });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onChatDelete).not.toHaveBeenCalled();
  });

  // The dialog must name what the row names, so an unnamed chat cannot read as a different one.
  it('uses the untitled fallback in the confirmation title', () => {
    renderSection({ archivedChats: [{ id: 'chat-3', name: null }] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Untitled chat' }));

    expect(screen.getByText('Delete "Untitled chat" permanently?')).toBeInTheDocument();
  });
});

// Deleting is async (it awaits a linked-task lookup first), so these cover what the list does
// while one or more deletes are still in flight.
describe('ArchivedChatsSection delete while in flight', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function deleteRow(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  }

  it('holds the row disabled until its own delete settles', async () => {
    const gate = deferred();
    renderSection({ archivedChats: TWO_CHATS, onChatDelete: () => gate.promise });

    deleteRow('Alpha');
    expect(screen.getByRole('button', { name: 'Delete Alpha' })).toBeDisabled();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(screen.getByRole('button', { name: 'Delete Alpha' })).not.toBeDisabled();
  });

  // Each row owns its own in-flight state: one delete finishing must not re-arm a different
  // row that is still mid-flight, or that row can be fired twice.
  it('keeps a second in-flight row disabled when the first delete settles', async () => {
    const alpha = deferred();
    const beta = deferred();
    renderSection({
      archivedChats: TWO_CHATS,
      onChatDelete: (chatId: string) => (chatId === 'chat-1' ? alpha : beta).promise,
    });

    deleteRow('Alpha');
    deleteRow('beta');
    expect(screen.getByRole('button', { name: 'Delete beta' })).toBeDisabled();

    await act(async () => {
      alpha.resolve();
      await alpha.promise;
    });

    expect(screen.getByRole('button', { name: 'Delete beta' })).toBeDisabled();
  });
});

describe('ArchivedChatsSection delete edge cases', () => {
  // Confirming unmounts the row that owns the trigger, so Radix's default focus restore has
  // nowhere to land and would drop the user out of the sidebar tree onto document.body.
  it('returns focus to the section rather than the document body', async () => {
    renderSection({ archivedChats: TWO_CHATS, onChatDelete: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });
    expect(document.activeElement?.textContent).toContain('Archived (2)');
  });

  // Chats can be archived or removed on another machine, so the list can refetch out from under
  // an open dialog. The confirmation must act on the id captured at click time.
  it('deletes the chat it was opened for even after that row leaves the list', () => {
    const onChatDelete = vi.fn();
    const { rerender } = renderSectionForRerender({ archivedChats: TWO_CHATS, onChatDelete });

    fireEvent.click(screen.getByRole('button', { name: 'Delete beta' }));
    rerender({ archivedChats: [TWO_CHATS[0]], onChatDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onChatDelete).toHaveBeenCalledWith('chat-2');
  });

  // Filtering changes which rows render; the delete must follow the row, not a list position.
  it('deletes the right chat while a search filter is narrowing the list', () => {
    const onChatDelete = vi.fn();
    renderSection({ archivedChats: TWO_CHATS, searchQuery: 'bet', onChatDelete });

    fireEvent.click(screen.getByRole('button', { name: 'Delete beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onChatDelete).toHaveBeenCalledWith('chat-2');
    expect(onChatDelete).toHaveBeenCalledTimes(1);
  });
});
