// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNodeDragData, TreeNodeDropData } from './TreeNode';
import { DragButton, DropRoot } from './TreeNode.dnd';

/**
 * Unit tests for the dnd-kit wrapper components inside TreeNode.
 * These wrappers isolate `useDroppable` / `useDraggable` subscriptions so TreeNode's heavy body
 * doesn't re-render on every DndContext update. The handler-composition logic in DragButton is
 * subtle: dnd-kit's listener fires AFTER the consumer's (Radix Slot) handler, unless the consumer
 * calls `preventDefault` — matching Radix's `composeEventHandlers` contract. Regressions here
 * would silently break either context menus or drag activation.
 */

const dndMocks = vi.hoisted(() => ({
  dndPointerDown: vi.fn(),
  dndKeyDown: vi.fn(),
  draggableSetNodeRef: vi.fn<(el: HTMLElement | null) => void>(),
  droppableSetNodeRef: vi.fn<(el: HTMLElement | null) => void>(),
  isOver: false,
}));

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: { 'aria-roledescription': 'draggable' },
    listeners: { onPointerDown: dndMocks.dndPointerDown, onKeyDown: dndMocks.dndKeyDown },
    setNodeRef: dndMocks.draggableSetNodeRef,
    isDragging: false,
  }),
  useDroppable: () => ({
    setNodeRef: dndMocks.droppableSetNodeRef,
    isOver: dndMocks.isOver,
  }),
}));

// Minimum mocks so TreeNode.tsx module can load (we only use DragButton/DropRoot exports).
vi.mock('lucide-react', () => ({
  ClipboardPaste: () => null,
  ChevronRight: () => null,
  Copy: () => null,
  Loader2: () => null,
  PencilLine: () => null,
}));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuSeparator: () => null,
}));
vi.mock('@/hooks/use-context-menu-focus-handoff', () => ({
  useContextMenuFocusHandoff: () => ({
    markNextCloseForInputFocus: vi.fn(),
    handleCloseAutoFocus: vi.fn(),
  }),
}));
vi.mock('@/lib/hotkeys/shortcut-registry', () => ({
  getShortcutAction: () => null,
  keysToDisplay: () => '',
}));
vi.mock('@/lib/trpc', () => ({
  trpc: { external: { openInFinder: { useMutation: () => ({ mutate: vi.fn() }) } } },
  trpcClient: { files: { listDirectory: { query: vi.fn() } } },
}));
vi.mock('@/lib/utils', () => ({
  cn: (...cs: Array<string | false | null | undefined>) => cs.filter(Boolean).join(' '),
}));
vi.mock('@/lib/utils/platform', () => ({ getRevealLabel: () => '' }));
vi.mock('../../agents/mentions/agents-file-mention', () => ({
  getFileIconByExtension: () => null,
}));
const dragData: TreeNodeDragData = {
  type: 'tree-node',
  nodePath: 'src/index.ts',
  nodeType: 'file',
  nodeName: 'index.ts',
  projectPath: '/tmp/proj',
};

const dropData: TreeNodeDropData = {
  type: 'tree-folder',
  folderPath: 'src',
  projectPath: '/tmp/proj',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  dndMocks.isOver = false;
});

describe('DragButton', () => {
  describe('event handler composition', () => {
    it('fires both the consumer onPointerDown and dnd-kit listener when preventDefault is not called', () => {
      const consumer = vi.fn();
      const { container } = render(
        <DragButton draggableId="d" draggableData={dragData} onPointerDown={consumer}>
          handle
        </DragButton>,
      );
      const btn = container.querySelector('button');
      expect(btn).not.toBeNull();

      btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

      expect(consumer).toHaveBeenCalledOnce();
      expect(dndMocks.dndPointerDown).toHaveBeenCalledOnce();
    });

    it('suppresses the dnd-kit pointerdown listener when the consumer calls preventDefault', () => {
      const consumer = vi.fn((e: React.PointerEvent<HTMLButtonElement>) => e.preventDefault());
      const { container } = render(
        <DragButton draggableId="d" draggableData={dragData} onPointerDown={consumer}>
          handle
        </DragButton>,
      );

      const btn = container.querySelector('button');
      btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

      expect(consumer).toHaveBeenCalledOnce();
      expect(dndMocks.dndPointerDown).not.toHaveBeenCalled();
    });

    it('fires both onKeyDown handlers (keyboard drag activation)', () => {
      const consumer = vi.fn();
      const { container } = render(
        <DragButton draggableId="d" draggableData={dragData} onKeyDown={consumer}>
          handle
        </DragButton>,
      );

      const btn = container.querySelector('button');
      btn?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));

      expect(consumer).toHaveBeenCalledOnce();
      expect(dndMocks.dndKeyDown).toHaveBeenCalledOnce();
    });

    it('suppresses the dnd-kit keydown listener when the consumer calls preventDefault', () => {
      const consumer = vi.fn((e: React.KeyboardEvent<HTMLButtonElement>) => e.preventDefault());
      const { container } = render(
        <DragButton draggableId="d" draggableData={dragData} onKeyDown={consumer}>
          handle
        </DragButton>,
      );

      const btn = container.querySelector('button');
      btn?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: ' ', cancelable: true }),
      );

      expect(consumer).toHaveBeenCalledOnce();
      expect(dndMocks.dndKeyDown).not.toHaveBeenCalled();
    });
  });

  describe('ref composition', () => {
    it('forwards the DOM node to both the forwarded ref and dnd-kit setNodeRef', () => {
      const forwarded = createRef<HTMLButtonElement>();
      const { container } = render(
        <DragButton draggableId="d" draggableData={dragData} ref={forwarded}>
          handle
        </DragButton>,
      );

      const btn = container.querySelector('button') as HTMLButtonElement;
      expect(forwarded.current).toBe(btn);
      expect(dndMocks.draggableSetNodeRef).toHaveBeenCalledWith(btn);
    });
  });
});

describe('DropRoot', () => {
  it('applies overClassName when isOver is true', () => {
    dndMocks.isOver = true;
    const { container } = render(
      <DropRoot
        id="drop-test"
        data={dropData}
        disabled={false}
        className="base"
        overClassName="bg-primary/10"
      >
        child
      </DropRoot>,
    );

    const div = container.querySelector('div') as HTMLDivElement;
    expect(div.className).toContain('base');
    expect(div.className).toContain('bg-primary/10');
  });

  it('does not apply overClassName when isOver is false', () => {
    dndMocks.isOver = false;
    const { container } = render(
      <DropRoot
        id="drop-test"
        data={dropData}
        disabled={false}
        className="base"
        overClassName="bg-primary/10"
      >
        child
      </DropRoot>,
    );

    const div = container.querySelector('div') as HTMLDivElement;
    expect(div.className).toContain('base');
    expect(div.className).not.toContain('bg-primary/10');
  });

  it('does not apply overClassName even if isOver is true when disabled (guards against files becoming drop targets)', () => {
    dndMocks.isOver = true;
    const { container } = render(
      <DropRoot
        id="drop-test"
        data={dropData}
        disabled
        className="base"
        overClassName="bg-primary/10"
      >
        child
      </DropRoot>,
    );

    const div = container.querySelector('div') as HTMLDivElement;
    expect(div.className).toContain('base');
    expect(div.className).not.toContain('bg-primary/10');
  });

  it('does not attach the droppable ref when disabled (files must not register as drop targets)', () => {
    render(
      <DropRoot id="drop-test" data={dropData} disabled>
        child
      </DropRoot>,
    );

    // When disabled, the wrapper returns `ref={undefined}` on the div, so the droppable setNodeRef
    // is never called with the DOM element. Prevents file nodes from participating in collision
    // detection even if dnd-kit's own `disabled` flag is ever misused.
    expect(dndMocks.droppableSetNodeRef).not.toHaveBeenCalledWith(expect.any(HTMLElement));
  });
});
