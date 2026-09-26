import { describe, expect, it, vi } from 'vitest';

const randomUUIDMock = vi.hoisted(() => vi.fn(() => '00000000-0000-4000-8000-000000000099'));

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock,
}));

import {
  applyCurrentBatchIdForBriefingTransition,
  type GraphWithSettings,
  isBriefingPopulated,
} from './apply-current-batch-id';

const VALID_PREV_BATCH = 'a1b2c3d4-e5f6-4789-abcd-ef1234567890';

describe('isBriefingPopulated', () => {
  it('returns false for undefined, null, non-string, empty, whitespace-only', () => {
    expect(isBriefingPopulated(undefined)).toBe(false);
    expect(isBriefingPopulated(null)).toBe(false);
    expect(isBriefingPopulated(42)).toBe(false);
    expect(isBriefingPopulated('')).toBe(false);
    expect(isBriefingPopulated('   \t\n')).toBe(false);
  });

  it('returns true for non-whitespace content', () => {
    expect(isBriefingPopulated('x')).toBe(true);
    expect(isBriefingPopulated('  hello  ')).toBe(true);
  });
});

describe('applyCurrentBatchIdForBriefingTransition', () => {
  it('strips client-sent currentBatchId before applying transitions', () => {
    const graph = {
      settings: { briefing: 'PRD', currentBatchId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    };
    applyCurrentBatchIdForBriefingTransition(graph, 'old', VALID_PREV_BATCH);
    expect(graph.settings?.currentBatchId).toBe(VALID_PREV_BATCH);
  });

  it('empty to populated: assigns randomUUID()', () => {
    randomUUIDMock.mockClear();
    const graph: GraphWithSettings = { settings: { briefing: 'New PRD' } };
    applyCurrentBatchIdForBriefingTransition(graph, undefined, undefined);
    expect(randomUUIDMock).toHaveBeenCalled();
    expect(graph.settings?.currentBatchId).toBe('00000000-0000-4000-8000-000000000099');
  });

  it('populated to empty: leaves currentBatchId absent after strip', () => {
    const graph: GraphWithSettings = { settings: { briefing: '' } };
    applyCurrentBatchIdForBriefingTransition(graph, 'was set', VALID_PREV_BATCH);
    expect(graph.settings?.currentBatchId).toBeUndefined();
  });

  it('populated to populated: carries valid prev_batch_id', () => {
    const graph: GraphWithSettings = { settings: { briefing: 'updated text' } };
    applyCurrentBatchIdForBriefingTransition(graph, 'old', VALID_PREV_BATCH);
    expect(graph.settings?.currentBatchId).toBe(VALID_PREV_BATCH);
  });

  it('populated to populated: replaces invalid prev_batch_id via randomUUID()', () => {
    randomUUIDMock.mockClear();
    const graph: GraphWithSettings = { settings: { briefing: 'updated' } };
    applyCurrentBatchIdForBriefingTransition(graph, 'old', 'not-a-uuid');
    expect(randomUUIDMock).toHaveBeenCalled();
    expect(graph.settings?.currentBatchId).toBe('00000000-0000-4000-8000-000000000099');
  });

  it('populated to populated: generates new id when prev_batch_id is null (legacy rows)', () => {
    randomUUIDMock.mockClear();
    const graph: GraphWithSettings = { settings: { briefing: 'updated' } };
    applyCurrentBatchIdForBriefingTransition(graph, 'old', null);
    expect(randomUUIDMock).toHaveBeenCalled();
    expect(graph.settings?.currentBatchId).toBe('00000000-0000-4000-8000-000000000099');
  });

  it('empty to empty: does not set currentBatchId', () => {
    const graph: GraphWithSettings = { settings: {} };
    applyCurrentBatchIdForBriefingTransition(graph, undefined, undefined);
    expect(graph.settings?.currentBatchId).toBeUndefined();
  });

  it('empty to populated with no settings object: no-op', () => {
    const graph: { settings?: Record<string, unknown> } = {};
    applyCurrentBatchIdForBriefingTransition(graph, undefined, undefined);
    expect(graph.settings).toBeUndefined();
  });

  it('treats whitespace-only incoming briefing as not populated', () => {
    const graph: GraphWithSettings = { settings: { briefing: '   ' } };
    applyCurrentBatchIdForBriefingTransition(graph, undefined, undefined);
    expect(graph.settings?.currentBatchId).toBeUndefined();
  });
});
