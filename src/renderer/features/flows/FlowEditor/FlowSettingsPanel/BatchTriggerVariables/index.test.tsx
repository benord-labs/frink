// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchTriggerSchemaItem } from '../../../../../../shared/types/flow-settings-schema';

// ---------------------------------------------------------------------------
// Stable mock state (vi.hoisted runs before factories and module imports)
// ---------------------------------------------------------------------------

const snap = vi.hoisted(() => ({
  listBatchStagesData: undefined as { stages: Array<{ id: string }> } | undefined,
  listBatchStagesIsLoading: false,
  listBatchStagesIsError: false,
  listBatchStageRunsData: undefined as
    | { runs: Array<{ trigger_context: Record<string, unknown> | null }>; total: number }
    | undefined,
  listBatchStageRunsIsLoading: false,
  listBatchStageRunsIsError: false,
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      listBatchStages: {
        useQuery: () => ({
          data: snap.listBatchStagesData,
          isLoading: snap.listBatchStagesIsLoading,
          isError: snap.listBatchStagesIsError,
        }),
      },
      listBatchStageRuns: {
        useQuery: () => ({
          data: snap.listBatchStageRunsData,
          isLoading: snap.listBatchStageRunsIsLoading,
          isError: snap.listBatchStageRunsIsError,
        }),
      },
    },
  },
}));

// Transparent UI component mocks — avoid Radix portal and animation overhead.
vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: ({
    children,
    onClick,
    disabled,
    type,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../../components/ui/label', () => ({
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../../../components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectValue: () => null,
}));

// Dynamic import AFTER mocks are registered.
const { BatchTriggerVariables } = await import('./index');

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function renderBTV({
  batchId = 'batch-abc',
  schema = undefined,
  onChange = vi.fn(),
}: {
  batchId?: string | null | undefined;
  schema?: BatchTriggerSchemaItem[];
  onChange?: (s: BatchTriggerSchemaItem[] | undefined) => void;
} = {}) {
  render(
    <BatchTriggerVariables
      flowId="flow-xyz"
      batchId={batchId}
      schema={schema}
      onChange={onChange}
    />,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  snap.listBatchStagesData = undefined;
  snap.listBatchStagesIsLoading = false;
  snap.listBatchStagesIsError = false;
  snap.listBatchStageRunsData = undefined;
  snap.listBatchStageRunsIsLoading = false;
  snap.listBatchStageRunsIsError = false;
});

// ---------------------------------------------------------------------------
// From runs: loading / empty / key display
// ---------------------------------------------------------------------------

describe('FromRunsSection — loading and empty states', () => {
  it('shows "Loading…" while stages query is in flight', () => {
    snap.listBatchStagesIsLoading = true;
    renderBTV();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows "No runs yet" when stages loaded but no runs exist', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = { runs: [], total: 0 };
    renderBTV();
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });

  it('shows detected key chips from trigger_context', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { ticketId: 'sc-123' } }],
      total: 1,
    };
    renderBTV();
    expect(screen.getByText(/trigger\.ticketId/)).toBeInTheDocument();
  });

  it('shows primitive example value', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { ticketId: 'sc-123' } }],
      total: 1,
    };
    renderBTV();
    expect(screen.getByText(/e\.g\. sc-123/)).toBeInTheDocument();
  });

  it('From runs section absent when batchId is null (no batch started yet)', () => {
    renderBTV({ batchId: null });
    // Intro copy mentions "From runs"; assert the section-only empty state is not mounted.
    expect(
      screen.queryByText(
        /No runs yet — detected variables will appear here once the batch starts/i,
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Detected trigger variables from runs')).not.toBeInTheDocument();
  });

  it('null trigger_context value shows no example text', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { optionalKey: null } }],
      total: 1,
    };
    renderBTV();
    expect(screen.getByText(/trigger\.optionalKey/)).toBeInTheDocument();
    expect(screen.queryByText(/e\.g\./)).not.toBeInTheDocument();
  });

  it('skips runs with null trigger_context entirely', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: null }, { trigger_context: { realKey: 'ok' } }],
      total: 2,
    };
    renderBTV();
    expect(screen.getByText(/trigger\.realKey/)).toBeInTheDocument();
    expect(screen.queryByText(/trigger\.undefined/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// EC-NEW-1: Object/array values display correctly (not [object Object])
// ---------------------------------------------------------------------------

describe('FromRunsSection — EC-NEW-1: object and array value display', () => {
  it('EC-NEW-1: object trigger_context values display as JSON, not [object Object]', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { metadata: { category: 'frontend', priority: 5 } } }],
      total: 1,
    };
    renderBTV();
    // The [object Object] antipattern must NOT appear
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    // Should show some JSON representation (starts with '{')
    expect(screen.getByText(/e\.g\. \{/)).toBeInTheDocument();
  });

  it('EC-NEW-1: array trigger_context values display as JSON, not comma-joined', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { branches: ['main', 'dev'] } }],
      total: 1,
    };
    renderBTV();
    // String(['main','dev']) produces "main,dev" — must NOT appear
    expect(screen.queryByText(/e\.g\. main,dev/)).not.toBeInTheDocument();
    // JSON.stringify produces '["main","dev"]' — must appear
    expect(screen.getByText(/e\.g\. \[/)).toBeInTheDocument();
  });

  it('EC-NEW-1: boolean values render as "true"/"false", not "[object Object]"', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { autoStart: true } }],
      total: 1,
    };
    renderBTV();
    expect(screen.getByText(/e\.g\. true/)).toBeInTheDocument();
  });

  it('EC-NEW-1: number values render correctly', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { count: 42 } }],
      total: 1,
    };
    renderBTV();
    expect(screen.getByText(/e\.g\. 42/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// EC-NEW-2: Query error state
// ---------------------------------------------------------------------------

describe('FromRunsSection — EC-NEW-2: error state', () => {
  it('EC-NEW-2: stages query error shows error message, not "No runs yet"', () => {
    snap.listBatchStagesIsError = true;
    renderBTV();
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/Could not load/i)).toBeInTheDocument();
  });

  it('EC-NEW-2: stage runs query error shows error message, not "No runs yet"', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsIsError = true;
    renderBTV();
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/Could not load/i)).toBeInTheDocument();
  });

  it('EC-NEW-2: error state does not show loading indicator', () => {
    snap.listBatchStagesIsError = true;
    renderBTV();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Declared key highlighting in From runs
// ---------------------------------------------------------------------------

describe('FromRunsSection — declared key highlighting', () => {
  it('undeclared keys show "not declared" label', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { undeclaredKey: 'value' } }],
      total: 1,
    };
    renderBTV({ schema: [] });
    expect(screen.getByText('not declared')).toBeInTheDocument();
  });

  it('declared keys do not show "not declared" label', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { myKey: 'value' } }],
      total: 1,
    };
    renderBTV({ schema: [{ key: 'myKey', type: 'string' }] });
    expect(screen.queryByText('not declared')).not.toBeInTheDocument();
  });

  it('mix of declared and undeclared keys: only undeclared shows label', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { known: 'a', unknown: 'b' } }],
      total: 1,
    };
    renderBTV({ schema: [{ key: 'known', type: 'string' }] });
    const labels = screen.getAllByText('not declared');
    expect(labels).toHaveLength(1);
  });

  it('EC9: static trigger keys (label, customInstructions) never show "not declared" badge', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [{ trigger_context: { label: 'Task A', customInstructions: 'foo', storyId: 'sc-1' } }],
      total: 1,
    };
    renderBTV({ schema: [] }); // no declared schema
    // storyId is custom — should show badge
    expect(screen.getByText('not declared')).toBeInTheDocument();
    // label and customInstructions are static — must NOT show badge even with empty schema
    const allBadges = screen.queryAllByText('not declared');
    expect(allBadges).toHaveLength(1); // only storyId
  });
});

// ---------------------------------------------------------------------------
// EC-DEDUP: same key across multiple runs only shown once
// ---------------------------------------------------------------------------

describe('FromRunsSection — EC-DEDUP: key deduplication across runs', () => {
  it('EC-DEDUP: same triggerContext key in multiple runs appears only once', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [
        { trigger_context: { ticketId: 'sc-001', workstreamId: 'ws-a' } },
        { trigger_context: { ticketId: 'sc-002', workstreamId: 'ws-b' } },
        { trigger_context: { ticketId: 'sc-003', workstreamId: 'ws-c' } },
      ],
      total: 3,
    };
    renderBTV();
    // Each key should appear exactly once regardless of how many runs contain it.
    expect(screen.queryAllByText(/trigger\.ticketId/)).toHaveLength(1);
    expect(screen.queryAllByText(/trigger\.workstreamId/)).toHaveLength(1);
  });

  it('EC-DEDUP: example value shown is from the first run, not later duplicates', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [
        { trigger_context: { ticketId: 'sc-FIRST' } },
        { trigger_context: { ticketId: 'sc-SECOND' } },
      ],
      total: 2,
    };
    renderBTV();
    expect(screen.getByText(/e\.g\. sc-FIRST/)).toBeInTheDocument();
    expect(screen.queryByText(/e\.g\. sc-SECOND/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// EC-STATIC-COMPLETE: all 6 static keys excluded from "not declared"
// ---------------------------------------------------------------------------

describe('FromRunsSection — EC-STATIC-COMPLETE: full static key set', () => {
  it('EC-STATIC-COMPLETE: baseBranch, baseBranches, mergeStrategy, attachments never show "not declared"', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [
        {
          trigger_context: {
            baseBranch: 'main',
            baseBranches: ['main', 'dev'],
            mergeStrategy: 'squash',
            attachments: [],
            customKey: 'custom-value', // only this should get the badge
          },
        },
      ],
      total: 1,
    };
    renderBTV({ schema: [] });
    // Only the one non-static custom key should carry the badge.
    const badges = screen.queryAllByText('not declared');
    expect(badges).toHaveLength(1);
  });

  it('EC-STATIC-COMPLETE: schema=undefined still filters all static keys from "not declared"', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [
        {
          trigger_context: {
            baseBranch: 'main',
            label: 'my-label',
            customKey: 'custom-value',
          },
        },
      ],
      total: 1,
    };
    // schema=undefined exercises the `schema ?? []` fallback path
    renderBTV({ schema: undefined });
    const badges = screen.queryAllByText('not declared');
    // baseBranch and label are static; only customKey should be flagged
    expect(badges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EC-DECLARED-RESOLVE: CEO auto-merged keys fully resolve in From runs
// ---------------------------------------------------------------------------

describe('FromRunsSection — EC-DECLARED-RESOLVE: auto-merged schema resolves badges', () => {
  it('EC-DECLARED-RESOLVE: CEO-injected keys present in batchTriggerSchema show no amber badge', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [
        {
          trigger_context: {
            label: 'Create Image Studio nav entry',
            ticketId: 'sc-662273',
            workstreamId: 'nav-stepper',
          },
        },
      ],
      total: 1,
    };
    // Simulate batchTriggerSchema as it looks after auto-merge ran.
    renderBTV({
      schema: [
        { key: 'ticketId', type: 'string' },
        { key: 'workstreamId', type: 'string' },
      ],
    });
    expect(screen.queryByText('not declared')).not.toBeInTheDocument();
  });

  it('EC-DECLARED-RESOLVE: only undeclared custom keys get badge when schema has some auto-merged keys', () => {
    snap.listBatchStagesData = { stages: [{ id: 'stage-001' }] };
    snap.listBatchStageRunsData = {
      runs: [
        {
          trigger_context: {
            ticketId: 'sc-001', // declared → no badge
            workstreamId: 'nav-auth', // declared → no badge
            undocumentedKey: 'value', // not declared → badge
          },
        },
      ],
      total: 1,
    };
    renderBTV({
      schema: [
        { key: 'ticketId', type: 'string' },
        { key: 'workstreamId', type: 'string' },
      ],
    });
    const badges = screen.queryAllByText('not declared');
    expect(badges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EC10: Duplicate key prevention in declared section
// ---------------------------------------------------------------------------

describe('DeclaredVariables — EC10: duplicate key validation', () => {
  it('EC10: adding a key that already exists shows "Key already declared" error', () => {
    renderBTV({ schema: [{ key: 'workstreamId', type: 'string' }] });
    const input = screen.getByLabelText('New variable key');
    fireEvent.change(input, { target: { value: 'workstreamId' } });
    fireEvent.click(screen.getByLabelText('Add variable'));
    expect(screen.getByText('Key already declared')).toBeInTheDocument();
  });

  it('EC10: error clears when the input value is changed after duplicate attempt', () => {
    renderBTV({ schema: [{ key: 'workstreamId', type: 'string' }] });
    const input = screen.getByLabelText('New variable key');
    fireEvent.change(input, { target: { value: 'workstreamId' } });
    fireEvent.click(screen.getByLabelText('Add variable'));
    expect(screen.getByText('Key already declared')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'newKey' } });
    expect(screen.queryByText('Key already declared')).not.toBeInTheDocument();
  });
});
