/**
 * Handler-level tests for the merged frink_flows_get_batch tool (list-runs,
 * batch-summary, and stages modes) plus frink_batch_message / define_stages / start_batch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFirstContentText } from './test-helpers';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above the import of handleFlowsToolCall
// ---------------------------------------------------------------------------

const mockListFlowRuns = vi.fn();
const mockListFlowBatchRuns = vi.fn();
const mockSendBatchMessage = vi.fn();
const mockDefineFlowBatchStages = vi.fn();
const mockListFlowBatchStages = vi.fn();
const mockStartFlowBatch = vi.fn();
const mockGetFlow = vi.fn();

vi.mock('../../flows/mcp-cloud-shim', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listFlowRuns: (...args: unknown[]) => mockListFlowRuns(...args),
    listFlowBatchRuns: (...args: unknown[]) => mockListFlowBatchRuns(...args),
    sendBatchMessage: (...args: unknown[]) => mockSendBatchMessage(...args),
    defineFlowBatchStages: (...args: unknown[]) => mockDefineFlowBatchStages(...args),
    listFlowBatchStages: (...args: unknown[]) => mockListFlowBatchStages(...args),
    startFlowBatch: (...args: unknown[]) => mockStartFlowBatch(...args),
    getFlow: (...args: unknown[]) => mockGetFlow(...args),
  };
});

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { handleFlowsToolCall } = await import('./index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLOW_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const BATCH_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const RUN_ID_1 = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const RUN_ID_2 = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';

function makeDbFlowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID_1,
    flow_version_id: FLOW_ID,
    user_id: 'user-1',
    status: 'completed',
    trigger_context: null,
    idempotency_key: null,
    batch_id: BATCH_ID,
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:01:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeBatchRunRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makeDbFlowRun(overrides),
    chat_id: null,
    ...overrides,
  };
}

function callTool(name: string, args: Record<string, unknown>, executionId = 'test-session') {
  return handleFlowsToolCall(name, args, executionId);
}

/** Parsed MCP tool JSON body — tests assert on shape; `any` avoids nested `unknown` noise. */
function parseToolResultJson(result: { content?: Array<{ text?: string }> } | null | undefined) {
  // biome-ignore lint/suspicious/noExplicitAny: test payload shape varies by tool
  return JSON.parse(getFirstContentText(result)) as any;
}

// ---------------------------------------------------------------------------
// frink_flows_get_batch (list-runs mode — no batchId)
// ---------------------------------------------------------------------------

describe('frink_flows_get_batch (list-runs mode)', () => {
  beforeEach(() => {
    mockListFlowRuns.mockReset();
  });

  it('returns correct shape with runs and count', async () => {
    mockListFlowRuns.mockResolvedValueOnce([
      makeDbFlowRun({ id: RUN_ID_1, status: 'completed' }),
      makeDbFlowRun({ id: RUN_ID_2, status: 'failed', batch_id: null }),
    ]);

    const result = await callTool('frink_flows_get_batch', { flowId: FLOW_ID });

    expect(result).not.toBeNull();
    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.flowId).toBe(FLOW_ID);
    expect(data.count).toBe(2);
    expect(data.runs).toHaveLength(2);
    expect(data.runs[0].id).toBe(RUN_ID_1);
    expect(data.runs[0].status).toBe('completed');
    expect(data.runs[0].batch_id).toBe(BATCH_ID);
    expect(data.runs[1].batch_id).toBeNull();
  });

  it('passes limit to listFlowRuns', async () => {
    mockListFlowRuns.mockResolvedValueOnce([]);
    await callTool('frink_flows_get_batch', { flowId: FLOW_ID, limit: 5 });
    expect(mockListFlowRuns).toHaveBeenCalledWith(FLOW_ID, 5);
  });

  it('uses default limit 20 when not provided', async () => {
    mockListFlowRuns.mockResolvedValueOnce([]);
    await callTool('frink_flows_get_batch', { flowId: FLOW_ID });
    expect(mockListFlowRuns).toHaveBeenCalledWith(FLOW_ID, 20);
  });

  it('rejects empty flowId', async () => {
    const result = await callTool('frink_flows_get_batch', { flowId: '' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/flowId must be a non-empty string/);
  });

  it('accepts a cuid2 flowId (local-first short id)', async () => {
    mockListFlowRuns.mockResolvedValueOnce([]);
    const result = await callTool('frink_flows_get_batch', { flowId: 'mq7vqzr0om5lnt7l' });
    expect(result?.isError).toBe(false);
    expect(mockListFlowRuns).toHaveBeenCalledWith('mq7vqzr0om5lnt7l', 20);
  });

  it('rejects limit > 50', async () => {
    const result = await callTool('frink_flows_get_batch', { flowId: FLOW_ID, limit: 51 });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Invalid arguments/);
  });

  it('returns generic error on non-404 failure', async () => {
    mockListFlowRuns.mockRejectedValueOnce(new Error('network timeout'));
    const result = await callTool('frink_flows_get_batch', { flowId: FLOW_ID });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Failed to list flow runs/);
    expect(result?.content[0].text).toMatch(/network timeout/);
  });

  it('returns null for unknown tool name', async () => {
    const result = await callTool('frink_flows_unknown_tool', { flowId: FLOW_ID });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// frink_flows_get_batch — dispatch routing robustness
// ---------------------------------------------------------------------------

describe('frink_flows_get_batch (dispatch routing)', () => {
  beforeEach(() => {
    mockListFlowRuns.mockReset();
    mockListFlowBatchRuns.mockReset();
    mockListFlowBatchStages.mockReset();
    mockListFlowRuns.mockResolvedValue([makeDbFlowRun()]);
    mockListFlowBatchRuns.mockResolvedValue({ runs: [makeBatchRunRow()], total: 1 });
    mockListFlowBatchStages.mockResolvedValue({ stages: [] });
  });

  it('routes to batch summary (not list-runs) when batchId is present but include is malformed', async () => {
    // A malformed `include` (non-enum value) must NOT discard a valid batchId and
    // silently fall back to the run list.
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      include: ['bogus'],
    });
    expect(result?.isError).toBe(false);
    expect(mockListFlowBatchRuns).toHaveBeenCalledTimes(1);
    expect(mockListFlowRuns).not.toHaveBeenCalled();
  });

  it('routes to batch summary when include is a string instead of an array', async () => {
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      include: 'stages',
    });
    expect(result?.isError).toBe(false);
    expect(mockListFlowBatchRuns).toHaveBeenCalledTimes(1);
    expect(mockListFlowRuns).not.toHaveBeenCalled();
  });

  it('routes to stages when batchId + include:["stages"]', async () => {
    await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      include: ['stages'],
    });
    expect(mockListFlowBatchStages).toHaveBeenCalledTimes(1);
    expect(mockListFlowRuns).not.toHaveBeenCalled();
  });

  it('ignores include and lists runs when no batchId is given', async () => {
    await callTool('frink_flows_get_batch', { flowId: FLOW_ID, include: ['stages'] });
    expect(mockListFlowRuns).toHaveBeenCalledTimes(1);
    expect(mockListFlowBatchStages).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// frink_flows_get_batch
// ---------------------------------------------------------------------------

describe('frink_flows_get_batch', () => {
  beforeEach(() => {
    mockListFlowBatchRuns.mockReset();
  });

  it('returns correct shape with aggregated counts', async () => {
    mockListFlowBatchRuns.mockResolvedValueOnce({
      runs: [
        makeBatchRunRow({ id: RUN_ID_1, status: 'completed' }),
        makeBatchRunRow({ id: RUN_ID_2, status: 'failed' }),
      ],
      total: 2,
    });

    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.flowId).toBe(FLOW_ID);
    expect(data.batchId).toBe(BATCH_ID);
    expect(data.total).toBe(2);
    expect(data.completed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.active).toBe(0);
    expect(data.runs).toHaveLength(2);
  });

  it('aggregates active count (running + paused + pending)', async () => {
    mockListFlowBatchRuns.mockResolvedValueOnce({
      runs: [
        makeBatchRunRow({ status: 'running' }),
        makeBatchRunRow({ status: 'paused', id: RUN_ID_2 }),
        makeBatchRunRow({ status: 'pending', id: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55' }),
      ],
      total: 3,
    });

    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    const data = parseToolResultJson(result);
    expect(data.active).toBe(3);
    expect(data.completed).toBe(0);
    expect(data.failed).toBe(0);
  });

  it('counts cancelled runs as failed', async () => {
    mockListFlowBatchRuns.mockResolvedValueOnce({
      runs: [
        makeBatchRunRow({ status: 'failed' }),
        makeBatchRunRow({ status: 'cancelled', id: RUN_ID_2 }),
      ],
      total: 2,
    });

    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    const data = parseToolResultJson(result);
    expect(data.failed).toBe(2);
  });

  it('total reflects full batch even when runs list is paged', async () => {
    const pageRuns = Array.from({ length: 20 }, (_, i) => ({
      ...makeBatchRunRow({ status: 'completed' }),
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    mockListFlowBatchRuns.mockResolvedValueOnce({ runs: pageRuns, total: 150 });

    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    const data = parseToolResultJson(result);
    expect(data.total).toBe(150);
    expect(data.runs).toHaveLength(20);
    expect(data.completed).toBe(20); // only from returned page
  });

  it('passes status filter to listFlowBatchRuns', async () => {
    mockListFlowBatchRuns.mockResolvedValueOnce({ runs: [], total: 0 });

    await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      status: 'failed',
      limit: 10,
    });

    expect(mockListFlowBatchRuns).toHaveBeenCalledWith(FLOW_ID, BATCH_ID, {
      status: 'failed',
      limit: 10,
    });
  });

  it('rejects invalid status value', async () => {
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      status: 'not-a-status',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Invalid arguments/);
  });

  it('rejects empty flowId', async () => {
    const result = await callTool('frink_flows_get_batch', {
      flowId: '',
      batchId: BATCH_ID,
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/flowId must be a non-empty string/);
  });

  it('rejects non-UUID batchId', async () => {
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: 'bad-batch',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/batchId must be a valid UUID/);
  });

  it('rejects limit > 100', async () => {
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      limit: 101,
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Invalid arguments/);
  });

  it('returns generic error on API failure', async () => {
    mockListFlowBatchRuns.mockRejectedValueOnce(new Error('upstream 503'));
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Failed to fetch batch/);
  });

  it('enforces the shared rate limit of 40 per session', async () => {
    mockListFlowBatchRuns.mockResolvedValue({ runs: [], total: 0 });
    const session = 'rate-limit-test-batch';
    for (let i = 0; i < 40; i++) {
      await callTool('frink_flows_get_batch', { flowId: FLOW_ID, batchId: BATCH_ID }, session);
    }
    const result = await callTool(
      'frink_flows_get_batch',
      { flowId: FLOW_ID, batchId: BATCH_ID },
      session,
    );
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(
      /Rate limit reached: frink_flows_get_batch allows 40 calls per chat session\./,
    );
  });

  it('different sessions have independent rate limits', async () => {
    mockListFlowBatchRuns.mockResolvedValue({ runs: [], total: 0 });
    const session1 = 'batch-session-a';
    const session2 = 'batch-session-b';
    for (let i = 0; i < 40; i++) {
      await callTool('frink_flows_get_batch', { flowId: FLOW_ID, batchId: BATCH_ID }, session1);
    }
    // session1 is exhausted but session2 should still work
    const result = await callTool(
      'frink_flows_get_batch',
      { flowId: FLOW_ID, batchId: BATCH_ID },
      session2,
    );
    expect(result?.isError).toBe(false);
  });

  it('run entries include chat_id field', async () => {
    const CHAT_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
    mockListFlowBatchRuns.mockResolvedValueOnce({
      runs: [makeBatchRunRow({ chat_id: CHAT_ID })],
      total: 1,
    });

    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    const data = parseToolResultJson(result);
    expect(data.runs[0].chat_id).toBe(CHAT_ID);
  });
});

// ---------------------------------------------------------------------------
// frink_batch_message
// ---------------------------------------------------------------------------

describe('frink_batch_message', () => {
  beforeEach(() => {
    mockSendBatchMessage.mockReset();
  });

  it('returns success shape on broadcast', async () => {
    mockSendBatchMessage.mockResolvedValueOnce({
      success: true,
      queued: 0,
      delivered: 5,
      message: 'Broadcast queued',
    });

    const result = await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      message: 'Please add tests for all exported functions.',
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.success).toBe(true);
    expect(data.delivered).toBe(5);
    expect(data.message).toBe('Broadcast queued');
    expect(mockSendBatchMessage).toHaveBeenCalledWith(
      FLOW_ID,
      BATCH_ID,
      'Please add tests for all exported functions.',
      undefined,
    );
  });

  it('passes flowRunId for targeted message', async () => {
    mockSendBatchMessage.mockResolvedValueOnce({
      success: true,
      queued: 1,
      delivered: 0,
      message: 'Targeted message sent',
    });

    await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      message: 'Focus on the auth module only.',
      flowRunId: RUN_ID_1,
    });

    expect(mockSendBatchMessage).toHaveBeenCalledWith(
      FLOW_ID,
      BATCH_ID,
      'Focus on the auth module only.',
      RUN_ID_1,
    );
  });

  it('rejects empty message', async () => {
    const result = await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      message: '',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/message must not be empty/);
  });

  it('rejects message > 10000 chars', async () => {
    const result = await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      message: 'x'.repeat(10001),
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/10000 characters/);
  });

  it('rejects non-UUID batchId', async () => {
    const result = await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: 'not-uuid',
      message: 'Hello',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/batchId must be a valid UUID/);
  });

  it('rejects empty flowRunId', async () => {
    const result = await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      message: 'Hello',
      flowRunId: '',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/flowRunId must be a non-empty string/);
  });

  it('returns generic error on API failure', async () => {
    mockSendBatchMessage.mockRejectedValueOnce(new Error('network error'));
    const result = await callTool('frink_batch_message', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      message: 'Hello',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Failed to send batch message/);
  });
});

// ---------------------------------------------------------------------------
// frink_flows_define_stages
// ---------------------------------------------------------------------------

describe('frink_flows_define_stages', () => {
  beforeEach(() => {
    mockDefineFlowBatchStages.mockReset();
  });

  const STAGE_1_RUN = { triggerContext: { ticket: 'sc-101' } };
  const STAGE_2_RUN = { triggerContext: { ticket: 'sc-102' } };

  it('returns success shape with stage summary', async () => {
    mockDefineFlowBatchStages.mockResolvedValueOnce({
      stages: [
        { id: 'stage-1-id', stageNumber: 1, name: 'Planning', status: 'running', runCount: 1 },
        { id: 'stage-2-id', stageNumber: 2, name: 'Implement', status: 'pending', runCount: 2 },
      ],
    });

    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [
        { stageNumber: 1, name: 'Planning', runs: [STAGE_1_RUN] },
        { stageNumber: 2, name: 'Implement', runs: [STAGE_2_RUN, STAGE_2_RUN] },
      ],
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.success).toBe(true);
    expect(data.stageCount).toBe(2);
    expect(data.stages[0].stageNumber).toBe(1);
    expect(data.stages[0].status).toBe('running');
    expect(data.stages[1].status).toBe('pending');
    expect(data.message).toMatch(/2 stage/);
  });

  it('refuses to stage more work while the batch is awaiting consent', async () => {
    // The consent card quotes a size; growing the batch under it would start
    // more work than the user was shown.
    const { markBatchAwaitingConsent, releaseBatchConsent } = await import(
      './gating/flow-invocation-consent'
    );
    markBatchAwaitingConsent(BATCH_ID);
    try {
      const result = await callTool('frink_flows_define_stages', {
        flowId: FLOW_ID,
        batchId: BATCH_ID,
        stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
      });

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toMatch(/cannot grow right now/);
      expect(mockDefineFlowBatchStages).not.toHaveBeenCalled();
    } finally {
      releaseBatchConsent(BATCH_ID);
    }
  });

  it('does not spend a session slot on a call refused by the freeze', async () => {
    // Otherwise repeated retries while the user decides would exhaust the
    // budget and dead-end the session with zero work done.
    const { markBatchAwaitingConsent, releaseBatchConsent } = await import(
      './gating/flow-invocation-consent'
    );
    const session = 'freeze-does-not-spend-quota';
    const args = {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    };
    mockDefineFlowBatchStages.mockResolvedValue({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 1 }],
    });

    markBatchAwaitingConsent(BATCH_ID);
    try {
      for (let i = 0; i < 25; i++) {
        await callTool('frink_flows_define_stages', args, session);
      }
    } finally {
      releaseBatchConsent(BATCH_ID);
    }

    // The budget is untouched, so real work still goes through afterwards.
    const after = await callTool('frink_flows_define_stages', args, session);
    expect(after?.isError).toBe(false);
  });

  it('rejects a stage that stages more runs than one call may carry', async () => {
    // Without a ceiling here a single stage could stage unbounded work, which
    // the start_batch consent card then has to quote back to the user.
    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: Array.from({ length: 51 }, () => STAGE_1_RUN) }],
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/max 50 runs per stage/);
    expect(mockDefineFlowBatchStages).not.toHaveBeenCalled();
  });

  it('accepts a stage at exactly the per-call run ceiling', async () => {
    mockDefineFlowBatchStages.mockResolvedValueOnce({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 50 }],
    });

    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: Array.from({ length: 50 }, () => STAGE_1_RUN) }],
    });

    expect(result?.isError).toBe(false);
  });

  it('enforces a per-session cap on define_stages calls', async () => {
    const session = 'define-stages-rate-limit-session';
    mockDefineFlowBatchStages.mockResolvedValue({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 1 }],
    });

    for (let i = 0; i < 20; i++) {
      const ok = await callTool(
        'frink_flows_define_stages',
        { flowId: FLOW_ID, batchId: BATCH_ID, stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }] },
        session,
      );
      expect(ok?.isError).toBe(false);
    }

    const refused = await callTool(
      'frink_flows_define_stages',
      { flowId: FLOW_ID, batchId: BATCH_ID, stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }] },
      session,
    );

    expect(refused?.isError).toBe(true);
    expect(refused?.content[0].text).toMatch(/max 20 define_stages calls per session/);
  });

  it('counts the define_stages cap per session, not globally', async () => {
    mockDefineFlowBatchStages.mockResolvedValue({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 1 }],
    });

    const args = {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    };
    for (let i = 0; i < 20; i++) await callTool('frink_flows_define_stages', args, 'session-a');

    // A different chat must start with a full budget.
    const other = await callTool('frink_flows_define_stages', args, 'session-b');
    expect(other?.isError).toBe(false);
  });

  it('clears its session budget through the exported reset', async () => {
    // The six per-tool limiters now share one factory and export a DETACHED
    // reset method. If that method ever closed over `this` instead of its own
    // map, every reset would silently no-op and turn teardown would leak.
    const { resetDefineStagesCount } = await import('./index');
    const session = 'define-stages-reset-session';
    mockDefineFlowBatchStages.mockResolvedValue({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 1 }],
    });
    const args = {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    };

    for (let i = 0; i < 20; i++) await callTool('frink_flows_define_stages', args, session);
    expect((await callTool('frink_flows_define_stages', args, session))?.isError).toBe(true);

    resetDefineStagesCount(session);

    expect((await callTool('frink_flows_define_stages', args, session))?.isError).toBe(false);
  });

  it('passes stages array to defineFlowBatchStages', async () => {
    mockDefineFlowBatchStages.mockResolvedValueOnce({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 1 }],
    });

    await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    });

    expect(mockDefineFlowBatchStages).toHaveBeenCalledWith(FLOW_ID, BATCH_ID, [
      { stageNumber: 1, runs: [STAGE_1_RUN] },
    ]);
  });

  it('rejects empty flowId', async () => {
    const result = await callTool('frink_flows_define_stages', {
      flowId: '',
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/flowId must be a non-empty string/);
  });

  it('accepts a cuid2 flowId (local-first short id)', async () => {
    mockDefineFlowBatchStages.mockResolvedValueOnce({
      stages: [{ id: 's', stageNumber: 1, name: null, status: 'running', runCount: 1 }],
    });
    const result = await callTool('frink_flows_define_stages', {
      flowId: 'mq7vqzr0om5lnt7l',
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    });
    expect(result?.isError).toBe(false);
    expect(mockDefineFlowBatchStages).toHaveBeenCalledWith('mq7vqzr0om5lnt7l', BATCH_ID, [
      { stageNumber: 1, runs: [STAGE_1_RUN] },
    ]);
  });

  it('rejects stageNumber < 1', async () => {
    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 0, runs: [STAGE_1_RUN] }],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/stageNumber must be >= 1/);
  });

  it('rejects stage with empty runs array', async () => {
    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [] }],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/each stage must have at least one run/);
  });

  it('rejects more than 50 stages', async () => {
    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: Array.from({ length: 51 }, (_, i) => ({
        stageNumber: i + 1,
        runs: [STAGE_1_RUN],
      })),
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/max 50 stages/);
  });

  it('returns generic error on API failure', async () => {
    mockDefineFlowBatchStages.mockRejectedValueOnce(new Error('server unavailable'));
    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [{ stageNumber: 1, runs: [STAGE_1_RUN] }],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Failed to define batch stages/);
  });

  it('sc-647: returns partial success shape with retry guidance when server returns 207', async () => {
    mockDefineFlowBatchStages.mockResolvedValueOnce({
      partial: true,
      stages: [
        { id: 'stage-1-id', stageNumber: 1, name: 'Planning', status: 'running', runCount: 1 },
      ],
      rootStageCount: 1,
      maxDepth: 1,
      failedStages: [{ stageNumber: 2, error: 'stage_insert_failed' }],
    });

    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [
        { stageNumber: 1, runs: [STAGE_1_RUN] },
        { stageNumber: 2, runs: [STAGE_2_RUN] },
      ],
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.success).toBe('partial');
    expect(data.stageCount).toBe(1);
    expect(data.stages[0].stageNumber).toBe(1);
    expect(data.stages[0].status).toBe('running');
    expect(data.failedStages).toHaveLength(1);
    expect(data.failedStages[0].stageNumber).toBe(2);
    expect(data.failedStages[0].error).toBe('stage_insert_failed');
    expect(data.message).toMatch(/1 stage\(s\) defined, 1 failed/);
    expect(data.message).toMatch(/\[2\]/);
    expect(data.message).toMatch(/full run list/);
    expect(data.message).toMatch(/will be replaced/);
  });

  it('sc-647: partial success maps every failedStages entry with per-stage error codes', async () => {
    mockDefineFlowBatchStages.mockResolvedValueOnce({
      partial: true,
      stages: [
        { id: 'stage-1-id', stageNumber: 1, name: 'Planning', status: 'running', runCount: 1 },
      ],
      rootStageCount: 1,
      maxDepth: 1,
      failedStages: [
        { stageNumber: 2, error: 'stage_insert_failed' },
        { stageNumber: 5, error: 'stage_insert_failed' },
      ],
    });

    const result = await callTool('frink_flows_define_stages', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      stages: [
        { stageNumber: 1, runs: [STAGE_1_RUN] },
        { stageNumber: 2, runs: [STAGE_2_RUN] },
        { stageNumber: 5, runs: [STAGE_2_RUN] },
      ],
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.success).toBe('partial');
    expect(data.failedStages).toHaveLength(2);
    expect(data.failedStages[0]).toEqual({ stageNumber: 2, error: 'stage_insert_failed' });
    expect(data.failedStages[1]).toEqual({ stageNumber: 5, error: 'stage_insert_failed' });
    expect(data.message).toMatch(/\[2, 5\]/);
  });
});

// ---------------------------------------------------------------------------
// frink_flows_start_batch
// ---------------------------------------------------------------------------

describe('frink_flows_start_batch', () => {
  beforeEach(() => {
    mockStartFlowBatch.mockReset();
    // Batch dispatch executes the flow, so it reads the same standing
    // agent-run grant frink_flows_run does.
    mockGetFlow.mockReset();
    mockGetFlow.mockResolvedValue({ id: FLOW_ID, name: 'Batch flow', agent_invocable: true });
  });

  it('refuses to start a batch for a flow with no agent-run grant', async () => {
    mockGetFlow.mockResolvedValueOnce({
      id: FLOW_ID,
      name: 'Locked',
      agent_invocable: false,
    });

    const result = await callTool('frink_flows_start_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/does not allow agent runs yet/);
    expect(mockStartFlowBatch).not.toHaveBeenCalled();
  });

  it('starts a batch for an ungranted flow when the caller consented to this invocation', async () => {
    mockGetFlow.mockResolvedValueOnce({
      id: FLOW_ID,
      name: 'Locked',
      agent_invocable: false,
    });
    mockStartFlowBatch.mockResolvedValueOnce({
      started: true,
      startedStageNumbers: [1],
      totalEnqueued: 2,
    });

    const result = await handleFlowsToolCall(
      'frink_flows_start_batch',
      { flowId: FLOW_ID, batchId: BATCH_ID },
      undefined,
      undefined,
      { invocationConsented: true },
    );

    expect(result?.isError).toBe(false);
    expect(mockStartFlowBatch).toHaveBeenCalledWith(FLOW_ID, BATCH_ID);
  });

  it('maps started: false with reason and counts from startFlowBatch', async () => {
    mockStartFlowBatch.mockResolvedValueOnce({
      started: false,
      reason: 'all-roots-started',
      totalStages: 2,
      rootStageCount: 1,
      startedRootCount: 1,
      startedStageNumbers: [],
      totalEnqueued: 0,
    });

    const result = await callTool('frink_flows_start_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    expect(result?.isError).toBe(false);
    expect(mockStartFlowBatch).toHaveBeenCalledWith(FLOW_ID, BATCH_ID);
    const data = parseToolResultJson(result);
    expect(data.success).toBe(true);
    expect(data.started).toBe(false);
    expect(data.reason).toBe('all-roots-started');
    expect(data.totalStages).toBe(2);
    expect(data.rootStageCount).toBe(1);
    expect(data.startedRootCount).toBe(1);
    // Says the roots left pending, NOT that their runs are done: admission may still be holding them.
    expect(data.message).toMatch(/already left pending/);
  });

  it('uses unknown reason fallback when API omits reason', async () => {
    mockStartFlowBatch.mockResolvedValueOnce({
      started: false,
      totalStages: 1,
      rootStageCount: 1,
      startedRootCount: 0,
    });

    const result = await callTool('frink_flows_start_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.reason).toBe('unknown');
  });

  it('returns started: true with stage numbers and totalEnqueued', async () => {
    mockStartFlowBatch.mockResolvedValueOnce({
      started: true,
      startedStageNumbers: [1, 2],
      totalEnqueued: 3,
    });

    const result = await callTool('frink_flows_start_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.started).toBe(true);
    expect(data.startedStageNumbers).toEqual([1, 2]);
    expect(data.totalEnqueued).toBe(3);
    // Counts runs handed to admission, NOT runs executing — the two diverge whenever the queue holds.
    expect(data.message).toMatch(/3 run\(s\) submitted to Flow admission/);
  });

  it('enforces rate limit of 5 start_batch calls per session', async () => {
    mockStartFlowBatch.mockResolvedValue({ started: false, reason: 'all-roots-started' });
    const session = 'rate-limit-start-batch';
    for (let i = 0; i < 5; i++) {
      await callTool('frink_flows_start_batch', { flowId: FLOW_ID, batchId: BATCH_ID }, session);
    }
    const result = await callTool(
      'frink_flows_start_batch',
      { flowId: FLOW_ID, batchId: BATCH_ID },
      session,
    );
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Rate limit reached/);
  });
});

// ---------------------------------------------------------------------------
// frink_flows_get_batch (stages mode — batchId + include:['stages'])
// ---------------------------------------------------------------------------

describe('frink_flows_get_batch (stages mode)', () => {
  beforeEach(() => {
    mockListFlowBatchStages.mockReset();
  });

  it('returns stages with correct shape and coerced counts', async () => {
    mockListFlowBatchStages.mockResolvedValueOnce({
      stages: [
        {
          id: 'stage-1',
          stage_number: 1,
          name: 'Planning',
          status: 'completed',
          failure_threshold: 0,
          run_count: '1',
          completed_count: '1',
          failed_count: '0',
          active_count: '0',
        },
        {
          id: 'stage-2',
          stage_number: 2,
          name: 'Implementation',
          status: 'running',
          failure_threshold: 0,
          run_count: '5',
          completed_count: '3',
          failed_count: '0',
          active_count: '2',
        },
      ],
    });

    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: BATCH_ID,
      include: ['stages'],
    });

    expect(result?.isError).toBe(false);
    const data = parseToolResultJson(result);
    expect(data.flowId).toBe(FLOW_ID);
    expect(data.batchId).toBe(BATCH_ID);
    expect(data.stageCount).toBe(2);
    // Counts should be coerced from strings to numbers
    expect(data.stages[0].runCount).toBe(1);
    expect(data.stages[0].completed).toBe(1);
    expect(data.stages[1].active).toBe(2);
    expect(data.stages[1].status).toBe('running');
  });

  it('rejects non-UUID batchId', async () => {
    const result = await callTool('frink_flows_get_batch', {
      flowId: FLOW_ID,
      batchId: 'not-a-uuid',
      include: ['stages'],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/batchId must be a valid UUID/);
  });

});
