import { describe, expect, it } from 'vitest';
import { parseFanOutItem, parseFanOutLane } from './parse-fan-out-lane';

describe('parseFanOutLane', () => {
  it('unwraps every branch result from an item aggregate', () => {
    const results = parseFanOutItem(
      {
        error: { summary: 'A', chatId: 'chat-a' },
        branchB: { taskStatus: 'needs_attention', error: 'B failed' },
      },
      3,
    );

    expect(results).toMatchObject([
      {
        laneIndex: 3,
        branchRootNodeId: 'error',
        status: 'passed',
        summary: 'A',
        chatId: 'chat-a',
      },
      {
        laneIndex: 3,
        branchRootNodeId: 'branchB',
        status: 'failed',
        errorMessage: 'B failed',
      },
    ]);
  });

  // ──────────────────────────────────────────────────────────
  // laneIndex
  // ──────────────────────────────────────────────────────────

  it('preserves laneIndex from caller', () => {
    expect(parseFanOutLane({}, 7).laneIndex).toBe(7);
  });

  // ──────────────────────────────────────────────────────────
  // Non-object / malformed items (fan-out can produce anything)
  // ──────────────────────────────────────────────────────────

  it('treats array item as empty outputs → skipped status', () => {
    const lane = parseFanOutLane([{ summary: 'ok' }], 0);
    expect(lane.status).toBe('skipped');
    expect(lane.summary).toBeUndefined();
    expect(lane.chatId).toBeUndefined();
  });

  it('treats null item as empty outputs → skipped status', () => {
    const lane = parseFanOutLane(null, 0);
    expect(lane.status).toBe('skipped');
  });

  it('treats numeric item as empty outputs → skipped status', () => {
    expect(parseFanOutLane(42, 0).status).toBe('skipped');
  });

  it('treats string item as empty outputs → skipped status', () => {
    expect(parseFanOutLane('ok', 0).status).toBe('skipped');
  });

  it('treats boolean item as empty outputs → skipped status', () => {
    expect(parseFanOutLane(true, 0).status).toBe('skipped');
  });

  // ──────────────────────────────────────────────────────────
  // summary extraction
  // ──────────────────────────────────────────────────────────

  it('extracts string summary', () => {
    const lane = parseFanOutLane({ summary: 'PASS: ok' }, 0);
    expect(lane.summary).toBe('PASS: ok');
    expect(lane.status).toBe('passed');
  });

  it('ignores non-string summary (number)', () => {
    const lane = parseFanOutLane({ summary: 42 }, 0);
    expect(lane.summary).toBeUndefined();
  });

  it('ignores non-string summary (object)', () => {
    const lane = parseFanOutLane({ summary: { text: 'ok' } }, 0);
    expect(lane.summary).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────
  // chatId extraction
  // ──────────────────────────────────────────────────────────

  it('extracts string chatId', () => {
    const lane = parseFanOutLane({ summary: 's', chatId: 'chat-abc' }, 0);
    expect(lane.chatId).toBe('chat-abc');
  });

  it('ignores non-string chatId', () => {
    const lane = parseFanOutLane({ chatId: 123 }, 0);
    expect(lane.chatId).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────
  // errorMessage extraction
  // ──────────────────────────────────────────────────────────

  it('extracts string error field directly', () => {
    const lane = parseFanOutLane({ taskStatus: 'needs_attention', error: 'something broke' }, 0);
    expect(lane.errorMessage).toBe('something broke');
    expect(lane.status).toBe('failed');
  });

  it('extracts message from error object with message field', () => {
    const lane = parseFanOutLane(
      { taskStatus: 'needs_attention', error: { message: 'disk full', code: 'ENOSPC' } },
      0,
    );
    expect(lane.errorMessage).toBe('disk full');
  });

  it('returns undefined errorMessage when error is a number', () => {
    const lane = parseFanOutLane({ taskStatus: 'needs_attention', error: 42 }, 0);
    expect(lane.errorMessage).toBeUndefined();
  });

  it('returns undefined errorMessage when error object has non-string message', () => {
    const lane = parseFanOutLane({ error: { message: ['a', 'b'] } }, 0);
    expect(lane.errorMessage).toBeUndefined();
  });

  it('returns undefined errorMessage when error object has no message key', () => {
    const lane = parseFanOutLane({ error: { code: 'E_FAIL' } }, 0);
    expect(lane.errorMessage).toBeUndefined();
  });

  it('returns undefined errorMessage when error is null', () => {
    const lane = parseFanOutLane({ error: null }, 0);
    expect(lane.errorMessage).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────
  // Combined fields — realistic PR-review lane shape
  // ──────────────────────────────────────────────────────────

  it('maps a typical passed PR-review lane', () => {
    const lane = parseFanOutLane(
      { summary: 'PASS: no issues found', chatId: 'c-001', exitCode: 0 },
      3,
    );
    expect(lane.laneIndex).toBe(3);
    expect(lane.status).toBe('passed');
    expect(lane.summary).toBe('PASS: no issues found');
    expect(lane.chatId).toBe('c-001');
    expect(lane.errorMessage).toBeUndefined();
  });

  it('maps a typical failed PR-review lane with needs_attention', () => {
    const lane = parseFanOutLane(
      { taskStatus: 'needs_attention', summary: 'FAIL: lint errors', chatId: 'c-002' },
      5,
    );
    expect(lane.status).toBe('failed');
    expect(lane.summary).toBe('FAIL: lint errors');
    expect(lane.chatId).toBe('c-002');
  });

  it('maps a lane with only chatId (no signal, no summary) → unknown', () => {
    const lane = parseFanOutLane({ chatId: 'c-003' }, 0);
    expect(lane.status).toBe('unknown');
    expect(lane.chatId).toBe('c-003');
    expect(lane.summary).toBeUndefined();
  });
});
