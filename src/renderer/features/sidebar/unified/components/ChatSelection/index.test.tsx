// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createIdSelectionStore } from '../../../../../lib/tree-navigation';
import {
  ChatSelectionChip,
  ChatSelectionContext,
  ChatSelectionDragBadge,
  useChatRowSelection,
} from '.';

function Row({ id, open }: { id: string; open: (chatId: string) => void }) {
  const { isMultiSelected, onClick } = useChatRowSelection(id, open);
  return (
    <div data-sidebar-item="" data-item-type="chat" data-item-id={id}>
      <button type="button" aria-pressed={isMultiSelected} onClick={onClick}>
        {id}
      </button>
    </div>
  );
}

function renderTree(ids: string[]) {
  const store = createIdSelectionStore();
  const open = vi.fn();
  const view = render(
    <ChatSelectionContext.Provider value={store}>
      <div role="tree">
        {ids.map((id) => (
          <Row key={id} id={id} open={open} />
        ))}
      </div>
    </ChatSelectionContext.Provider>,
  );
  return { store, open, view };
}

const selected = (store: ReturnType<typeof createIdSelectionStore>) => [...store.getSnapshot()];

describe('useChatRowSelection', () => {
  it('toggles on Cmd+click without opening the chat', () => {
    const { store, open } = renderTree(['a', 'b']);
    fireEvent.click(screen.getByText('a'), { metaKey: true });
    fireEvent.click(screen.getByText('b'), { ctrlKey: true });
    expect(selected(store)).toEqual(['a', 'b']);
    expect(screen.getByText('a').getAttribute('aria-pressed')).toBe('true');
    expect(open).not.toHaveBeenCalled();
  });

  it('Shift+click selects the visible range from the last plain-clicked chat', () => {
    const { store, open } = renderTree(['a', 'b', 'c', 'd']);
    fireEvent.click(screen.getByText('b'));
    fireEvent.click(screen.getByText('d'), { shiftKey: true });
    expect(selected(store)).toEqual(['b', 'c', 'd']);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('Shift+click ranges over chats only, never the project headers between them', () => {
    const store = createIdSelectionStore();
    render(
      <ChatSelectionContext.Provider value={store}>
        <div role="tree">
          <Row id="a" open={vi.fn()} />
          <div data-sidebar-item="" data-item-type="codebase" data-item-id="project-x" />
          <Row id="b" open={vi.fn()} />
        </div>
      </ChatSelectionContext.Provider>,
    );
    fireEvent.click(screen.getByText('a'), { metaKey: true });
    fireEvent.click(screen.getByText('b'), { shiftKey: true });
    expect(selected(store)).toEqual(['a', 'b']);
  });

  it('a plain click clears the selection and opens the chat', () => {
    const { store, open } = renderTree(['a', 'b']);
    fireEvent.click(screen.getByText('a'), { metaKey: true });
    fireEvent.click(screen.getByText('b'));
    expect(selected(store)).toEqual([]);
    expect(open).toHaveBeenCalledWith('b');
  });

  it('drops a row from the selection when it leaves the screen', () => {
    const { store, view } = renderTree(['a', 'b']);
    fireEvent.click(screen.getByText('a'), { metaKey: true });
    fireEvent.click(screen.getByText('b'), { metaKey: true });
    view.rerender(
      <ChatSelectionContext.Provider value={store}>
        <div role="tree">
          <Row key="b" id="b" open={vi.fn()} />
        </div>
      </ChatSelectionContext.Provider>,
    );
    expect(selected(store)).toEqual(['b']);
  });
});

function renderChip(store: ReturnType<typeof createIdSelectionStore>, pendingDeleteCount = 0) {
  const props = {
    onArchive: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onConfirmDelete: vi.fn(async () => {}),
    onCancelDelete: vi.fn(),
  };
  render(
    <ChatSelectionContext.Provider value={store}>
      <ChatSelectionChip {...props} pendingDeleteCount={pendingDeleteCount} />
      <ChatSelectionDragBadge chatId="a" />
    </ChatSelectionContext.Provider>,
  );
  return props;
}

describe('ChatSelectionChip', () => {
  it('stays hidden until something is selected', () => {
    renderChip(createIdSelectionStore());
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('acts on the selected chats and clears on ×', () => {
    const store = createIdSelectionStore();
    store.toggle('a');
    store.toggle('b');
    const props = renderChip(store);
    expect(screen.getByText('2 selected')).toBeTruthy();
    // Dragging 'a' carries 'b' along, so the drag ghost shows the full count.
    expect(screen.getByText('2')).toBeTruthy();

    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(screen.getByText('Delete'));
    expect(props.onArchive).toHaveBeenCalledWith(['a', 'b']);
    expect(props.onDelete).toHaveBeenCalledWith(['a', 'b']);

    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(store.getSnapshot().size).toBe(0);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('asks before deleting and only deletes on confirm', () => {
    const props = renderChip(createIdSelectionStore(), 3);
    expect(screen.getByText('Delete 3 chats permanently?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(props.onConfirmDelete).toHaveBeenCalledTimes(1);
  });
});
