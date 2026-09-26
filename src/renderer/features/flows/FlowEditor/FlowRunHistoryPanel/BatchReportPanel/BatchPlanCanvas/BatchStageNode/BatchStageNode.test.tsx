// @vitest-environment happy-dom
/**
 * BatchStageNode — above-LOW severity behavioral tests.
 *
 * Tests core interaction (click/keyboard selection), chat navigation, and accessibility.
 * Click is debounced 200ms — tests use vi.useFakeTimers() + vi.runAllTimers() and
 * fireEvent (synchronous) instead of userEvent to avoid async-timer conflicts.
 */

import type { Node, NodeProps } from '@xyflow/react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock RF components that need a ReactFlowProvider context to render
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

// Mock workstream-colors with deterministic values for testing
vi.mock('../workstream-colors', () => ({
  // Returns a recognizable string; tests check getAttribute('style') not style.borderLeftColor
  // (the latter requires valid CSS, but we want to confirm the value is passed through)
  getWorkstreamColor: (id: string) => `var(--ws-${id})`,
  getWorkstreamAbbrev: (id: string) => id.slice(0, 2).toUpperCase(),
}));

// Mock cn utility
vi.mock('../../../../../../../lib/utils', () => ({
  cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(' '),
}));

// Mock stage status styles
vi.mock('../../stage-status-styles', () => ({
  getStatusPill: (status: string) => {
    const map: Record<string, { label: string; className: string; dotClassName?: string }> = {
      running: {
        label: 'Running',
        className: 'bg-primary/15 text-primary',
        dotClassName: 'bg-primary animate-pulse',
      },
      completed: { label: 'Done', className: 'bg-emerald-500/15 text-emerald-400' },
      failed: { label: 'Failed', className: 'bg-destructive/15 text-destructive' },
      pending: { label: 'Pending', className: 'bg-muted text-muted-foreground' },
      cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
    };
    return map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  },
  formatProgress: (completed: number, total: number) =>
    total === 0 ? '—' : `${completed}/${total}`,
}));

// Load BatchStageNode after mocks are set
import type { BatchStageNodeData } from '../build-batch-plan-graph';

const { BatchStageNode } = await import('.');

type BatchStageRfNode = Node<BatchStageNodeData, 'batchStage'>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeData(overrides: Partial<BatchStageNodeData> = {}): BatchStageNodeData {
  return {
    stage: {
      id: 'test-stage-id',
      stage_number: 3,
      name: 'Auth module',
      status: 'running',
      failure_threshold: 0,
      depends_on_stage_ids: [],
      depends_on_stage_numbers: [],
      run_count: 10,
      completed_count: 4,
      failed_count: 0,
      active_count: 3,
      attention_count: 0,
      pending_count: 0,
      latest_chat_id: null,
      workstream_ids: [],
    },
    isSelected: false,
    onSelect: vi.fn(),
    sourceEditable: true,
    targetEditable: true,
    ...overrides,
  };
}

/** Props React Flow injects on real nodes; stubbed for unit tests (component only uses `data`). */
function batchStageNodeProps(data: BatchStageNodeData): NodeProps<BatchStageRfNode> {
  return {
    id: data.stage.id,
    type: 'batchStage',
    data,
    selected: false,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

function renderNode(data: BatchStageNodeData) {
  return render(<BatchStageNode {...batchStageNodeProps(data)} />);
}

afterEach(cleanup);

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('BatchStageNode — rendering', () => {
  it('renders stage number badge', () => {
    renderNode(makeData());
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders stage name', () => {
    renderNode(makeData());
    expect(screen.getByText('Auth module')).toBeInTheDocument();
  });

  it('renders "Stage N" fallback when name is null', () => {
    renderNode(makeData({ stage: { ...makeData().stage, name: null } }));
    expect(screen.getByText('Stage 3')).toBeInTheDocument();
  });

  it('renders run progress as "completed/total"', () => {
    renderNode(makeData());
    expect(screen.getByText('4/10')).toBeInTheDocument();
  });

  it('renders "—" when run_count is 0 (no runs scheduled yet)', () => {
    const data = makeData();
    renderNode(makeData({ stage: { ...data.stage, run_count: 0, completed_count: 0 } }));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders status pill label for running stage', () => {
    renderNode(makeData());
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('renders status pill label for completed stage', () => {
    renderNode(makeData({ stage: { ...makeData().stage, status: 'completed' } }));
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});

// ── Interaction (click debounced 200ms — use fireEvent + fake timers) ─────────

describe('BatchStageNode — interaction', () => {
  it('calls onSelect(stageId) when clicking an unselected node (after debounce)', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    renderNode(makeData({ isSelected: false, onSelect }));
    fireEvent.click(screen.getByRole('button'));
    vi.runAllTimers();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('test-stage-id');
    vi.useRealTimers();
  });

  it('calls onSelect(null) when clicking the currently selected node (toggle off, after debounce)', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    renderNode(makeData({ isSelected: true, onSelect }));
    fireEvent.click(screen.getByRole('button'));
    vi.runAllTimers();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(null);
    vi.useRealTimers();
  });

  it('calls onSelect via Enter key (immediately — no debounce on keyboard)', () => {
    const onSelect = vi.fn();
    renderNode(makeData({ onSelect }));
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('test-stage-id');
  });

  it('calls onSelect via Space key (immediately — no debounce on keyboard)', () => {
    const onSelect = vi.fn();
    renderNode(makeData({ onSelect }));
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('test-stage-id');
  });

  it('does NOT call onSelect when pressing an unrelated key', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    renderNode(makeData({ onSelect }));
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' });
    vi.runAllTimers();
    expect(onSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ── Chat navigation ───────────────────────────────────────────────────────────

describe('BatchStageNode — chat navigation', () => {
  const CHAT_ID = 'chat-uuid-123';

  it('shows ExternalLink icon when stage.latest_chat_id is set and onOpenChat provided', () => {
    const data = makeData({
      stage: { ...makeData().stage, latest_chat_id: CHAT_ID },
      onOpenChat: vi.fn(),
    });
    renderNode(data);
    expect(screen.getByLabelText('Open agent chat')).toBeInTheDocument();
  });

  it('does NOT show ExternalLink icon when stage.latest_chat_id is null', () => {
    renderNode(makeData({ stage: { ...makeData().stage, latest_chat_id: null } }));
    expect(screen.queryByLabelText('Open agent chat')).not.toBeInTheDocument();
  });

  it('does NOT show ExternalLink icon when onOpenChat is undefined (even if chat id present)', () => {
    const data = makeData({
      stage: { ...makeData().stage, latest_chat_id: CHAT_ID },
      onOpenChat: undefined,
    });
    renderNode(data);
    expect(screen.queryByLabelText('Open agent chat')).not.toBeInTheDocument();
  });

  it('icon click calls onOpenChat with chatId and does NOT call onSelect (stopPropagation)', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onOpenChat = vi.fn();
    const data = makeData({
      stage: { ...makeData().stage, latest_chat_id: CHAT_ID },
      onSelect,
      onOpenChat,
    });
    renderNode(data);
    fireEvent.click(screen.getByLabelText('Open agent chat'));
    vi.runAllTimers();
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(onOpenChat).toHaveBeenCalledWith(CHAT_ID);
    expect(onSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('icon Enter key calls onOpenChat with chatId', () => {
    const onOpenChat = vi.fn();
    const data = makeData({ stage: { ...makeData().stage, latest_chat_id: CHAT_ID }, onOpenChat });
    renderNode(data);
    fireEvent.keyDown(screen.getByLabelText('Open agent chat'), { key: 'Enter' });
    expect(onOpenChat).toHaveBeenCalledWith(CHAT_ID);
  });

  it('double-click calls onOpenChat and cancels pending single-click timer', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onOpenChat = vi.fn();
    const data = makeData({
      stage: { ...makeData().stage, latest_chat_id: CHAT_ID },
      onSelect,
      onOpenChat,
    });
    renderNode(data);
    // getByRole finds multiple buttons when ExternalLink is present; use getAllByRole for the outer node
    const [outerNode] = screen.getAllByRole('button');
    fireEvent.dblClick(outerNode as HTMLElement);
    vi.runAllTimers();
    expect(onOpenChat).toHaveBeenCalledWith(CHAT_ID);
    // Single-click timers were cleared by dblclick — onSelect should NOT fire
    expect(onSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('EC-2: double-click on no-chat stage does NOT cancel single-click timer (selection still fires)', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    // Default makeData: latest_chat_id=null, onOpenChat=undefined
    const data = makeData({ onSelect });
    renderNode(data);
    const node = screen.getByRole('button');
    fireEvent.click(node); // starts 200ms selection timer
    fireEvent.dblClick(node); // no chat — should NOT cancel the timer
    vi.runAllTimers();
    expect(onSelect).toHaveBeenCalledWith('test-stage-id');
    vi.useRealTimers();
  });

  it('EC-9: Space key on icon calls onOpenChat and does NOT bubble to trigger onSelect', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onOpenChat = vi.fn();
    const data = makeData({
      stage: { ...makeData().stage, latest_chat_id: CHAT_ID },
      onSelect,
      onOpenChat,
    });
    renderNode(data);
    fireEvent.keyDown(screen.getByLabelText('Open agent chat'), { key: ' ' });
    vi.runAllTimers();
    expect(onOpenChat).toHaveBeenCalledWith(CHAT_ID);
    expect(onSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────

describe('BatchStageNode — accessibility', () => {
  it('has aria-pressed="false" on an unselected node', () => {
    renderNode(makeData({ isSelected: false }));
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('has aria-pressed="true" on a selected node', () => {
    renderNode(makeData({ isSelected: true }));
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('is keyboard focusable (tabIndex=0)', () => {
    renderNode(makeData());
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0');
  });
});

// ── Workstream border ─────────────────────────────────────────────────────────

describe('BatchStageNode — workstream border', () => {
  it('applies borderLeftColor style attribute when workstream_ids is non-empty', () => {
    const data = makeData({ stage: { ...makeData().stage, workstream_ids: ['auth'] } });
    renderNode(data);
    const node = screen.getByRole('button');
    // workstream-colors mock returns `var(--ws-auth)` for workstreamId "auth".
    // Use getAttribute('style') since CSS variable references bypass browser color validation.
    expect(node.getAttribute('style')).toContain('border-left-color: var(--ws-auth)');
  });

  it('does NOT apply borderLeftColor style attribute when workstream_ids is empty', () => {
    renderNode(makeData({ stage: { ...makeData().stage, workstream_ids: [] } }));
    const node = screen.getByRole('button');
    const style = node.getAttribute('style') ?? '';
    expect(style).not.toContain('border-left-color');
  });

  it('uses the first workstream ID when multiple are present', () => {
    const data = makeData({
      stage: { ...makeData().stage, workstream_ids: ['first-ws', 'second-ws'] },
    });
    renderNode(data);
    const node = screen.getByRole('button');
    expect(node.getAttribute('style')).toContain('border-left-color: var(--ws-first-ws)');
  });

  it('sets title attribute to workstream name when workstream present', () => {
    const data = makeData({ stage: { ...makeData().stage, workstream_ids: ['auth-module'] } });
    renderNode(data);
    const node = screen.getByRole('button');
    expect(node.getAttribute('title')).toBe('Workstream: auth-module');
  });

  it('does NOT set title attribute when workstream_ids is empty', () => {
    renderNode(makeData({ stage: { ...makeData().stage, workstream_ids: [] } }));
    const node = screen.getByRole('button');
    expect(node.getAttribute('title')).toBeNull();
  });

  it('uses first non-empty workstream_id when leading entries are empty strings', () => {
    const data = makeData({
      stage: { ...makeData().stage, workstream_ids: ['', 'auth'] },
    });
    renderNode(data);
    const node = screen.getByRole('button');
    expect(node.getAttribute('style')).toContain('border-left-color: var(--ws-auth)');
    expect(node.getAttribute('title')).toBe('Workstream: auth');
  });
});
