// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PaneFileTreeHandle } from '../../../../features/files-sidebar/PaneFileTree';
import { splitPaneFileTreesAtom } from '../../../files-sidebar/atoms';
import { splitViewAtom } from '../../atoms';
import { SplitViewContainer } from './index';
import type { SplitPaneData } from './types';

const mocks = vi.hoisted(() => {
  const createPaneHandle = () => ({
    setRootCreating: vi.fn(),
    getSelectedNodePath: vi.fn(() => null),
    getIsInlineActive: vi.fn(() => false),
    focusTree: vi.fn(),
    deleteSelectedNode: vi.fn(),
    getSelectedPaths: vi.fn(() => []),
    getSelectedItems: vi.fn(() => []),
    batchDelete: vi.fn(),
    clearSelection: vi.fn(),
  });

  return {
    dndHandlers: {
      current: null as null | {
        onDragEnd?: (event: unknown) => void;
      },
    },
    moveMutate: vi.fn(),
    batchMoveMutate: vi.fn(),
    invalidateList: vi.fn(),
    invalidateSearch: vi.fn(),
    showMoveToast: vi.fn(),
    paneHandles: [createPaneHandle(), createPaneHandle()],
  };
});

vi.mock('@dnd-kit/core', () => ({
  DndContext: (props: Record<string, unknown>) => {
    mocks.dndHandlers.current = props as { onDragEnd?: (event: unknown) => void };
    return <div data-testid="dnd-context">{props.children as ReactNode}</div>;
  },
  DragOverlay: (props: Record<string, unknown>) => (
    <div data-testid="drag-overlay">{props.children as ReactNode}</div>
  ),
  getClientRect: vi.fn(() => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  })),
  MeasuringStrategy: {
    Always: 0,
    BeforeDragging: 1,
    WhileDragging: 2,
  },
  PointerSensor: class {},
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn((...sensors: unknown[]) => sensors),
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  })),
  useDroppable: vi.fn(() => ({
    setNodeRef: vi.fn(),
    isOver: false,
    active: null,
  })),
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      files: {
        listDirectory: { invalidate: mocks.invalidateList },
        search: { invalidate: mocks.invalidateSearch },
      },
    }),
    files: {
      moveFile: {
        useMutation: () => ({ mutate: mocks.moveMutate }),
      },
      batchMoveFiles: {
        useMutation: () => ({ mutate: mocks.batchMoveMutate }),
      },
    },
  },
}));

vi.mock('../../../../features/files-sidebar/use-file-tree-hotkeys', () => ({
  useFileTreeHotkeys: () => {},
}));

vi.mock('../../../../features/files-sidebar/CrossProjectDropDialog', () => ({
  CrossProjectDropDialog: () => null,
}));

vi.mock('@/features/files-sidebar/utils/batch-result-toasts', () => ({
  showMoveToast: mocks.showMoveToast,
}));

vi.mock('../../../../lib/focus-chat-input', () => ({
  focusChatInput: vi.fn(),
}));

vi.mock('./SplitDivider', () => ({
  SplitDivider: () => <div data-testid="split-divider" />,
}));

vi.mock('./GridDivider', () => ({
  GridDivider: () => <div data-testid="grid-divider" />,
}));

vi.mock('./SplitPaneFileTreeSidebar', () => ({
  SplitPaneFileTreeSidebar: ({
    paneIndex,
    onFileTreeRef,
  }: {
    paneIndex: number;
    onFileTreeRef: (handle: PaneFileTreeHandle | null) => void;
  }) => {
    useEffect(() => {
      const handle = mocks.paneHandles[paneIndex];
      onFileTreeRef(handle ?? null);
      return () => onFileTreeRef(null);
    }, [paneIndex, onFileTreeRef]);
    return null;
  },
}));

const panes: SplitPaneData[] = [
  {
    id: 'chat-1',
    label: 'Chat 1',
    projectPath: '/tmp/proj',
    content: <div>Pane 1</div>,
  },
  {
    id: 'chat-2',
    label: 'Chat 2',
    projectPath: '/tmp/proj',
    content: <div>Pane 2</div>,
  },
];

function renderContainer() {
  return render(
    <TooltipProvider>
      <Provider>
        <SplitViewContainer
          panes={panes}
          ratios={[0.5, 0.5]}
          onRatiosChange={() => {}}
          onRemovePane={() => {}}
          onCloseSplit={() => {}}
          activePaneIndex={0}
          onSetActivePane={() => {}}
          layout="horizontal"
          initialFileTreeOpen
        />
      </Provider>
    </TooltipProvider>,
  );
}

describe('SplitViewContainer file tree DnD', () => {
  beforeEach(() => {
    mocks.dndHandlers.current = null;
    mocks.moveMutate.mockReset();
    mocks.batchMoveMutate.mockReset();
    mocks.invalidateList.mockReset();
    mocks.invalidateSearch.mockReset();
    mocks.showMoveToast.mockReset();
    for (const handle of mocks.paneHandles) {
      handle.clearSelection?.mockClear();
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('broadcasts refresh and reveal after same-project drop success', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderContainer();
    dispatchSpy.mockClear();

    act(() => {
      mocks.dndHandlers.current?.onDragEnd?.({
        active: {
          data: {
            current: {
              type: 'tree-node',
              nodePath: 'src/old.ts',
              nodeType: 'file',
              nodeName: 'old.ts',
              projectPath: '/tmp/proj',
              paneIndex: 1,
            },
          },
        },
        over: {
          data: {
            current: {
              type: 'tree-folder',
              folderPath: 'src/components',
              projectPath: '/tmp/proj',
            },
          },
        },
      });
    });

    expect(mocks.moveMutate).toHaveBeenCalledTimes(1);
    expect(mocks.moveMutate).toHaveBeenCalledWith(
      {
        projectPath: '/tmp/proj',
        sourcePath: 'src/old.ts',
        destinationFolder: 'src/components',
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
      }),
    );

    const onSuccess = mocks.moveMutate.mock.calls[0]?.[1]?.onSuccess as (() => void) | undefined;
    expect(onSuccess).toBeTypeOf('function');

    act(() => {
      onSuccess?.();
    });

    expect(mocks.invalidateList).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateSearch).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls.map(([event]) => (event as Event).type)).toEqual([
      'file-tree-refresh',
      'file-tree-reveal',
    ]);

    dispatchSpy.mockRestore();
  });

  it('clears batch selection on the originating pane when the same project is open twice', () => {
    renderContainer();

    act(() => {
      mocks.dndHandlers.current?.onDragEnd?.({
        active: {
          data: {
            current: {
              type: 'tree-node',
              nodePath: 'src/a.ts',
              nodeType: 'file',
              nodeName: 'a.ts',
              projectPath: '/tmp/proj',
              paneIndex: 1,
              batchItems: [{ path: 'src/b.ts', name: 'b.ts', type: 'file' }],
            },
          },
        },
        over: {
          data: {
            current: {
              type: 'tree-folder',
              folderPath: 'src/dest',
              projectPath: '/tmp/proj',
            },
          },
        },
      });
    });

    expect(mocks.batchMoveMutate).toHaveBeenCalledTimes(1);
    expect(mocks.paneHandles[1].clearSelection).toHaveBeenCalledTimes(1);
    expect(mocks.paneHandles[0].clearSelection).not.toHaveBeenCalled();
  });

  it('routes the batch-move result to the undo-capable move toast', () => {
    renderContainer();

    act(() => {
      mocks.dndHandlers.current?.onDragEnd?.({
        active: {
          data: {
            current: {
              type: 'tree-node',
              nodePath: 'src/a.ts',
              nodeType: 'file',
              nodeName: 'a.ts',
              projectPath: '/tmp/proj',
              paneIndex: 1,
              batchItems: [{ path: 'src/b.ts', name: 'b.ts', type: 'file' }],
            },
          },
        },
        over: {
          data: {
            current: {
              type: 'tree-folder',
              folderPath: 'src/dest',
              projectPath: '/tmp/proj',
            },
          },
        },
      });
    });

    const results = [
      { sourcePath: 'src/a.ts', destPath: 'src/dest/a.ts', success: true },
      { sourcePath: 'src/b.ts', destPath: 'src/dest/b.ts', success: true },
    ];
    const onSuccess = mocks.batchMoveMutate.mock.calls[0]?.[1]?.onSuccess as
      | ((data: { results: typeof results }) => void)
      | undefined;
    expect(onSuccess).toBeTypeOf('function');

    act(() => {
      onSuccess?.({ results });
    });

    // The unit tests prove showMoveToast builds a working undo; this proves the
    // pane actually threads its result and project through to it.
    expect(mocks.showMoveToast).toHaveBeenCalledWith('/tmp/proj', results, expect.any(Function));
  });
});

describe('SplitViewContainer initial file trees atom', () => {
  let store: ReturnType<typeof createStore>;

  const splitProps = {
    ratios: [0.5, 0.5] as [number, number],
    onRatiosChange: () => {},
    onRemovePane: () => {},
    onCloseSplit: () => {},
    activePaneIndex: 0,
    onSetActivePane: () => {},
    layout: 'horizontal' as const,
  };

  function renderWithStore(panes: SplitPaneData[], initialFileTreeOpen: boolean) {
    return render(
      <TooltipProvider>
        <Provider store={store}>
          <SplitViewContainer
            panes={panes}
            initialFileTreeOpen={initialFileTreeOpen}
            {...splitProps}
          />
        </Provider>
      </TooltipProvider>,
    );
  }

  beforeEach(() => {
    store = createStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('seeds open file tree indices for all panes with projectPath when initialFileTreeOpen is true', () => {
    renderWithStore(panes, true);
    expect(Array.from(store.get(splitPaneFileTreesAtom)).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('keeps per-pane choices when an overlay remounts the split, and re-seeds after the split closes', () => {
    const split = { ratios: [0.5, 0.5], activePaneIndex: 0, layout: 'horizontal' as const };
    store.set(splitViewAtom, { ...split, chatIds: ['chat-1', 'chat-2'] });
    renderWithStore(panes, true).unmount();
    store.set(splitPaneFileTreesAtom, new Set([0]));

    // Settings replaces the split view while the split stays active.
    renderWithStore(panes, true).unmount();
    expect(Array.from(store.get(splitPaneFileTreesAtom))).toEqual([0]);

    // The split closes while Settings still hides it, then a new split opens.
    store.set(splitViewAtom, { ...split, chatIds: [] });
    store.set(splitViewAtom, { ...split, chatIds: ['chat-3', 'chat-4'] });
    renderWithStore(panes, true);
    expect(Array.from(store.get(splitPaneFileTreesAtom)).sort((a, b) => a - b)).toEqual([0, 1]);
    store.set(splitViewAtom, { ...split, chatIds: [] });
  });

  it('does not re-seed when panes are empty on first commit then load (documents didInit + omitted panes dep)', async () => {
    function PanesArriveAfterMount() {
      const [p, setP] = useState<SplitPaneData[]>([]);
      useEffect(() => {
        setP(panes);
      }, []);
      return <SplitViewContainer panes={p} initialFileTreeOpen {...splitProps} />;
    }
    render(
      <TooltipProvider>
        <Provider store={store}>
          <PanesArriveAfterMount />
        </Provider>
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-pane-index="1"]')).toBeTruthy();
    });
    expect(Array.from(store.get(splitPaneFileTreesAtom)).sort((a, b) => a - b)).toEqual([]);
  });
});
