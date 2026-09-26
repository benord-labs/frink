/** Drag data for pane reorder (distinct from file-tree TreeNodeDragData) */
export type PaneReorderDragData = { type: 'pane-reorder'; paneIndex: number };

export type SplitPaneData = {
  id: string;
  content: React.ReactNode;
  label?: string;
  /** Absolute project path for per-pane file tree (undefined for empty panes) */
  projectPath?: string;
  /** Whether this pane's file tree path is a chat worktree path. */
  isWorktree?: boolean;
};

export type SplitViewContainerProps = {
  panes: SplitPaneData[];
  ratios: number[];
  onRatiosChange: (ratios: number[]) => void;
  /** Grid row/column ratios for 3/4-pane (each array length 2, sums to 1). Undefined → equal. */
  gridRatios?: { rows: number[]; cols: number[] } | null;
  /** Called when user resizes grid dividers (commit on pointer up) */
  onGridRatiosChange?: (rows: number[], cols: number[]) => void;
  onRemovePane: (id: string | null, paneIndex: number) => void;
  onCloseSplit: () => void;
  /** Whether the single-pane file sidebar was open before split activated (persists pane 0 tree) */
  initialFileTreeOpen?: boolean;
  /** Index of the currently active (focused) pane */
  activePaneIndex: number;
  /** Callback to set a pane as active */
  onSetActivePane: (index: number) => void;
  /** Layout mode */
  layout: import('../../atoms').SplitLayout;
  /** Swap two panes by index (reorder) */
  onSwapPanes?: (fromIndex: number, toIndex: number) => void;
  /** Per-pane zoom factor (1 = 100%). Undefined → all 1. */
  paneZoomFactors?: number[];
  /** Reset zoom of a single pane to 1x (by pane index). */
  onResetPaneZoomAt?: (paneIndex: number) => void;
};
