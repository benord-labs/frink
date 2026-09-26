/**
 * Handler-level tests for the templates catalog (frink_flows_list_catalog with kind:'templates').
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFirstContentText } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above the import of handleFlowsToolCall
// ---------------------------------------------------------------------------

const mockListBatchPlanTemplates = vi.fn();

vi.mock('../../flows/mcp-cloud-shim', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listBatchPlanTemplates: (...args: unknown[]) => mockListBatchPlanTemplates(...args),
  };
});

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { handleFlowsToolCall, resetFlowsListTemplatesCount } = await import('./index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLOW_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const TEMPLATE_A = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_A,
    name: 'Plan-Impl-Review',
    stages: [
      { stageNumber: 1, name: 'Planning', dependsOn: [] },
      { stageNumber: 2, name: 'Implementation', dependsOn: [1] },
    ],
    schema_version: 1,
    source_flow_id: null,
    created_at: '2026-04-01T12:00:00Z',
    updated_at: '2026-04-01T12:00:00Z',
    ...overrides,
  };
}

function callTool(name: string, args: Record<string, unknown>) {
  return handleFlowsToolCall(name, args, 'test-session');
}

beforeEach(() => {
  mockListBatchPlanTemplates.mockReset();
  vi.clearAllMocks();
  resetFlowsListTemplatesCount();
});

// ---------------------------------------------------------------------------
// frink_flows_list_catalog (kind: 'templates')
// ---------------------------------------------------------------------------

describe("frink_flows_list_catalog (kind: 'templates')", () => {
  it('returns empty template list', async () => {
    mockListBatchPlanTemplates.mockResolvedValue([]);
    const result = await callTool('frink_flows_list_catalog', { kind: 'templates' });
    const text = getFirstContentText(result);
    const parsed = JSON.parse(text) as { templateCount: number; templates: unknown[] };
    expect(parsed.templateCount).toBe(0);
    expect(parsed.templates).toEqual([]);
  });

  it('returns templates with stages and usage hint', async () => {
    mockListBatchPlanTemplates.mockResolvedValue([makeTemplate()]);
    const result = await callTool('frink_flows_list_catalog', { kind: 'templates' });
    const text = getFirstContentText(result);
    const parsed = JSON.parse(text) as {
      templateCount: number;
      templates: Array<{ id: string; name: string; stageCount: number; stages: unknown[] }>;
      usage: string;
    };
    expect(parsed.templateCount).toBe(1);
    expect(parsed.templates[0].id).toBe(TEMPLATE_A);
    expect(parsed.templates[0].name).toBe('Plan-Impl-Review');
    expect(parsed.templates[0].stageCount).toBe(2);
    expect(parsed.templates[0].stages).toHaveLength(2);
    expect(parsed.usage).toMatch(/frink_flows_define_stages/);
  });

  it('accepts optional flowId param', async () => {
    mockListBatchPlanTemplates.mockResolvedValue([]);
    await callTool('frink_flows_list_catalog', { kind: 'templates', flowId: FLOW_ID });
    expect(mockListBatchPlanTemplates).toHaveBeenCalledWith(FLOW_ID);
  });

  it('returns error on empty flowId', async () => {
    const result = await callTool('frink_flows_list_catalog', {
      kind: 'templates',
      flowId: '',
    });
    expect(result?.content?.[0]?.text).toMatch(/invalid/i);
    // Should be an error result (isError)
    expect(result).toBeTruthy();
    expect(mockListBatchPlanTemplates).not.toHaveBeenCalled();
  });

  it('returns error result on API failure', async () => {
    mockListBatchPlanTemplates.mockRejectedValue(new Error('Network error'));
    const result = await callTool('frink_flows_list_catalog', { kind: 'templates' });
    const text = getFirstContentText(result);
    expect(text).toMatch(/failed/i);
  });

  it('rate-limits to 20 successful calls per session', async () => {
    mockListBatchPlanTemplates.mockResolvedValue([]);
    for (let i = 0; i < 20; i++) {
      const result = await callTool('frink_flows_list_catalog', { kind: 'templates' });
      expect(JSON.parse(getFirstContentText(result)).templateCount).toBe(0);
    }
    expect(mockListBatchPlanTemplates).toHaveBeenCalledTimes(20);
    const blocked = await callTool('frink_flows_list_catalog', { kind: 'templates' });
    expect(getFirstContentText(blocked)).toMatch(/Rate limit reached: frink_flows_list_catalog/);
    expect(mockListBatchPlanTemplates).toHaveBeenCalledTimes(20);
  });

  it('returns null for unknown tool name', async () => {
    const result = await callTool('frink_flows_unknown_tool', {});
    expect(result).toBeNull();
  });
});
