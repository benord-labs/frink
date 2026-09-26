// @vitest-environment happy-dom
/**
 * BatchPlanCanvas — EC-3: dagre must not re-run on status-only or selection-only changes.
 *
 * EC-3 (Medium severity): `BatchPlanCanvasInner.useMemo` currently lists `stages` and
 * `selectedStageId` as deps for the full `buildBatchPlanGraph` call (which includes dagre
 * layout). This means dagre re-runs on every socket-triggered status update AND on every
 * node click. The topology key is computed inside `buildBatchPlanGraph` but is not used at
 * the component level to guard the expensive layout step.
 *
 * Fix: export `computeTopologyKey` and use it as the sole dep for the dagre layout memo.
 * Selection state is overlaid on top of layout nodes in a separate, cheap useMemo.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';

// ── Track dagre.layout calls ─────────────────────────────────────────────────

const dagreLayoutSpy = vi.fn();

vi.mock('@dagrejs/dagre', () => {
  const mockGraphInstance = {
    setDefaultEdgeLabel: vi.fn().mockReturnThis(),
    setGraph: vi.fn().mockReturnThis(),
    setNode: vi.fn().mockReturnThis(),
    setEdge: vi.fn().mockReturnThis(),
    node: vi.fn().mockReturnValue({ x: 70, y: 26 }),
  };
  function MockGraph() {
    return mockGraphInstance;
  }
  MockGraph.prototype = mockGraphInstance;
  return {
    default: {
      graphlib: { Graph: MockGraph },
      layout: dagreLayoutSpy,
    },
  };
});

// ── Minimal React Flow mock ──────────────────────────────────────────────────

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="rf-canvas">{children}</div>
  ),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ControlButton: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  // Return false so fitView doesn't fire in test environment
  useNodesInitialized: vi.fn(() => false),
  useReactFlow: vi.fn(() => ({ fitView: vi.fn() })),
  // paneWidth: 0 so useCanvasFitView doesn't trigger fitView in tests
  useStore: vi.fn(() => 0),
}));

// ── Mock the node component — not needed for layout tests
vi.mock('./BatchStageNode', () => ({ BatchStageNode: () => null }));

// ── Mock DirtyNavAlertDialog — not needed for these tests
vi.mock('../DirtyNavAlertDialog', () => ({ DirtyNavAlertDialog: () => null }));

// ── Mock use-batch-edge-editing — not needed for layout/legend tests
vi.mock('./use-batch-edge-editing', () => ({
  useBatchEdgeEditing: () => ({
    localDeps: new Map(),
    isDirty: false,
    canUndo: false,
    isSaving: false,
    editableTargetIds: new Set(),
    editableSourceIds: new Set(),
    handleConnect: vi.fn(),
    isValidConnection: () => false,
    handleDeleteEdge: vi.fn(),
    handleUndo: vi.fn(),
    handleSave: vi.fn(),
    handleDiscard: vi.fn(),
    saveError: null,
    clearSaveError: vi.fn(),
  }),
}));

// ── Mock use-dirty-nav-guard
vi.mock('../../../../../../hooks/use-dirty-nav-guard', () => ({
  useDirtyNavGuard: () => ({
    showDialog: false,
    requestNav: vi.fn(),
    confirmNav: vi.fn(),
    cancelNav: vi.fn(),
  }),
}));

// ── Load component after all mocks ───────────────────────────────────────────

import { screen } from '@testing-library/react';

const { BatchPlanCanvas } = await import('./index');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStage(
  id: string,
  status: string,
  stageNum: number,
  depIds: string[] = [],
  workstreamIds: string[] = [],
): BatchStageDetail {
  return {
    id,
    stage_number: stageNum,
    name: null,
    status,
    failure_threshold: 0,
    depends_on_stage_ids: depIds,
    depends_on_stage_numbers: [],
    run_count: 2,
    completed_count: 0,
    failed_count: 0,
    active_count: 0,
    attention_count: 0,
    pending_count: 0,
    latest_chat_id: null,
    workstream_ids: workstreamIds,
  };
}

const STAGE_A = makeStage('s1', 'running', 1);
const STAGE_B = makeStage('s2', 'pending', 2, ['s1']);

afterEach(() => {
  cleanup();
  dagreLayoutSpy.mockClear();
});

// ── EC-3 tests ────────────────────────────────────────────────────────────────

describe('BatchPlanCanvas — EC-3: dagre layout memoization', () => {
  it('calls dagre on initial render', () => {
    render(
      <BatchPlanCanvas
        stages={[STAGE_A, STAGE_B]}
        selectedStageId={null}
        onSelectStage={vi.fn()}
      />,
    );
    expect(dagreLayoutSpy).toHaveBeenCalledTimes(1);
  });

  it('EC-3a: does NOT re-call dagre when stage statuses change but topology is unchanged', () => {
    const onSelectStage = vi.fn();
    const { rerender } = render(
      <BatchPlanCanvas
        stages={[STAGE_A, STAGE_B]}
        selectedStageId={null}
        onSelectStage={onSelectStage}
      />,
    );

    // Clear spy so only re-render calls are counted
    dagreLayoutSpy.mockClear();

    // Same IDs and dependency structure, different status — new array reference
    const updatedStages = [
      makeStage('s1', 'completed', 1), // ← status changed
      makeStage('s2', 'running', 2, ['s1']), // ← status changed
    ];

    rerender(
      <BatchPlanCanvas
        stages={updatedStages}
        selectedStageId={null}
        onSelectStage={onSelectStage}
      />,
    );

    // Dagre must NOT have been re-called — topology key is identical
    expect(dagreLayoutSpy).not.toHaveBeenCalled();
  });

  it('EC-3b: does NOT re-call dagre when selectedStageId changes (node click)', () => {
    const stages = [STAGE_A, STAGE_B];
    const onSelectStage = vi.fn();

    const { rerender } = render(
      <BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={onSelectStage} />,
    );

    dagreLayoutSpy.mockClear();

    // Simulate a node click changing the selection — topology unchanged
    rerender(
      <BatchPlanCanvas stages={stages} selectedStageId="s1" onSelectStage={onSelectStage} />,
    );

    // Dagre must NOT have been re-called — only selection changed
    expect(dagreLayoutSpy).not.toHaveBeenCalled();
  });

  it('EC-3c: DOES re-call dagre when a new dependency is added (topology change)', () => {
    const onSelectStage = vi.fn();
    // Initial: no deps between stages
    const initial = [makeStage('s1', 'completed', 1), makeStage('s2', 'pending', 2, [])];

    const { rerender } = render(
      <BatchPlanCanvas stages={initial} selectedStageId={null} onSelectStage={onSelectStage} />,
    );

    dagreLayoutSpy.mockClear();

    // Add dependency — topology changes
    const withDep = [makeStage('s1', 'completed', 1), makeStage('s2', 'pending', 2, ['s1'])];

    rerender(
      <BatchPlanCanvas stages={withDep} selectedStageId={null} onSelectStage={onSelectStage} />,
    );

    // Dagre SHOULD have been re-called — topology changed
    expect(dagreLayoutSpy).toHaveBeenCalledTimes(1);
  });

  it('EC-3d: does NOT re-call dagre when onSelectStage is a new reference (unstable callback)', () => {
    const stages = [STAGE_A, STAGE_B];

    const { rerender } = render(
      <BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={() => {}} />,
    );

    dagreLayoutSpy.mockClear();

    // Parent re-renders with a new onSelectStage reference (common without useCallback)
    rerender(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={() => {}} />);

    // Dagre must NOT have been re-called — only callback reference changed
    expect(dagreLayoutSpy).not.toHaveBeenCalled();
  });

  it('EC-3e: does NOT re-call dagre when workstream_ids changes but topology is unchanged', () => {
    const onSelectStage = vi.fn();
    const initial = [
      makeStage('s1', 'running', 1, [], []),
      makeStage('s2', 'pending', 2, ['s1'], []),
    ];

    const { rerender } = render(
      <BatchPlanCanvas stages={initial} selectedStageId={null} onSelectStage={onSelectStage} />,
    );

    dagreLayoutSpy.mockClear();

    // Same topology, different workstream assignments
    const withWorkstreams = [
      makeStage('s1', 'running', 1, [], ['auth']),
      makeStage('s2', 'pending', 2, ['s1'], ['api']),
    ];

    rerender(
      <BatchPlanCanvas
        stages={withWorkstreams}
        selectedStageId={null}
        onSelectStage={onSelectStage}
      />,
    );

    expect(dagreLayoutSpy).not.toHaveBeenCalled();
  });
});

// ── WorkstreamLegend visibility ───────────────────────────────────────────────

describe('BatchPlanCanvas — WorkstreamLegend visibility', () => {
  it('renders legend when >= 2 distinct workstreams exist', () => {
    const stages = [
      makeStage('s1', 'running', 1, [], ['auth']),
      makeStage('s2', 'pending', 2, ['s1'], ['api']),
    ];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Workstream legend' })).toBeInTheDocument();
  });

  it('renders legend when one stage aggregates multiple workstream_ids (DISTINCT runs)', () => {
    const stages = [makeStage('s1', 'running', 1, [], ['auth-module', 'api-module'])];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Workstream legend' })).toBeInTheDocument();
    expect(screen.getByText('auth-module')).toBeInTheDocument();
    expect(screen.getByText('api-module')).toBeInTheDocument();
  });

  it('does NOT render legend when all stages have empty workstream_ids', () => {
    const stages = [STAGE_A, STAGE_B];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    expect(screen.queryByRole('list', { name: 'Workstream legend' })).not.toBeInTheDocument();
  });

  it('does NOT render legend when only 1 distinct workstream exists', () => {
    const stages = [
      makeStage('s1', 'running', 1, [], ['auth']),
      makeStage('s2', 'pending', 2, ['s1'], ['auth']),
    ];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    expect(screen.queryByRole('list', { name: 'Workstream legend' })).not.toBeInTheDocument();
  });

  it('does NOT render legend for mixed stages where only 1 unique workstream appears', () => {
    const stages = [
      makeStage('s1', 'running', 1, [], ['auth']),
      makeStage('s2', 'pending', 2, ['s1'], []),
    ];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    expect(screen.queryByRole('list', { name: 'Workstream legend' })).not.toBeInTheDocument();
  });

  it('ignores empty and whitespace-only workstream_ids when counting distinct streams', () => {
    const stages = [
      makeStage('s1', 'running', 1, [], ['', '   ', 'alpha']),
      makeStage('s2', 'pending', 2, ['s1'], ['beta']),
    ];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Workstream legend' })).toBeInTheDocument();
  });

  it('legend entries are sorted alphabetically', () => {
    const stages = [
      makeStage('s1', 'running', 1, [], ['zzz-module']),
      makeStage('s2', 'pending', 2, [], ['aaa-module']),
      makeStage('s3', 'pending', 3, [], ['mmm-module']),
    ];
    render(<BatchPlanCanvas stages={stages} selectedStageId={null} onSelectStage={vi.fn()} />);
    const items = screen.getAllByRole('listitem');
    const names = items.map((el) => el.textContent?.trim() ?? '');
    // Alphabetical: aaa first, then mmm, then zzz
    const aaaIdx = names.findIndex((t) => t.includes('aaa'));
    const mmmIdx = names.findIndex((t) => t.includes('mmm'));
    const zzzIdx = names.findIndex((t) => t.includes('zzz'));
    expect(aaaIdx).toBeLessThan(mmmIdx);
    expect(mmmIdx).toBeLessThan(zzzIdx);
  });
});
