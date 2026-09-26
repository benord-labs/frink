import { describe, expect, it } from 'vitest';
import { deriveFanOutLaneStatus } from './derive-result-status';

describe('deriveFanOutLaneStatus', () => {
  // ──────────────────────────────────────────────────────────
  // Empty / skipped
  // ──────────────────────────────────────────────────────────

  it('returns skipped for empty outputs object', () => {
    expect(deriveFanOutLaneStatus({})).toBe('skipped');
  });

  it('returns unknown (not skipped) when outputs has keys but no recognisable signal', () => {
    // e.g. a lane that only carried chatId — not skipped, outcome indeterminate
    expect(deriveFanOutLaneStatus({ chatId: 'abc' })).toBe('unknown');
  });

  // ──────────────────────────────────────────────────────────
  // taskStatus checks (highest priority)
  // ──────────────────────────────────────────────────────────

  it('returns failed when taskStatus is needs_attention', () => {
    expect(deriveFanOutLaneStatus({ taskStatus: 'needs_attention' })).toBe('failed');
  });

  it('taskStatus needs_attention beats a done-like summary → still failed', () => {
    expect(
      deriveFanOutLaneStatus({ taskStatus: 'needs_attention', summary: 'PASS: all good' }),
    ).toBe('failed');
  });

  it('taskStatus needs_attention beats an explicit signal in outputs → still failed', () => {
    // outputs.signal would only exist if a run_command script wrote it to stdout
    expect(
      deriveFanOutLaneStatus({ taskStatus: 'needs_attention', signal: 'done', summary: 'ok' }),
    ).toBe('failed');
  });

  // ──────────────────────────────────────────────────────────
  // outputs.signal (only present when a run_command script emits it)
  // ──────────────────────────────────────────────────────────

  it('returns passed for signal done', () => {
    expect(deriveFanOutLaneStatus({ signal: 'done', summary: 'ok' })).toBe('passed');
  });

  it('returns passed for signal completed', () => {
    expect(deriveFanOutLaneStatus({ signal: 'completed' })).toBe('passed');
  });

  it('returns failed for signal failed', () => {
    expect(deriveFanOutLaneStatus({ signal: 'failed' })).toBe('failed');
  });

  it('returns unknown for signal awaiting_input', () => {
    expect(deriveFanOutLaneStatus({ signal: 'awaiting_input' })).toBe('unknown');
  });

  it('returns unknown for signal blocked', () => {
    expect(deriveFanOutLaneStatus({ signal: 'blocked' })).toBe('unknown');
  });

  it('returns unknown for signal partial', () => {
    expect(deriveFanOutLaneStatus({ signal: 'partial' })).toBe('unknown');
  });

  it('signal manual_confirmation (not in handled list) falls through to summary check', () => {
    // manual_confirmation is not handled → falls to summary fallback
    expect(deriveFanOutLaneStatus({ signal: 'manual_confirmation', summary: 'waiting' })).toBe(
      'passed',
    );
    expect(deriveFanOutLaneStatus({ signal: 'manual_confirmation' })).toBe('unknown');
  });

  // ──────────────────────────────────────────────────────────
  // Summary-based fallback (common for agent nodes, whose signal
  // lives on the NodeOutput wrapper, NOT in outputs)
  // ──────────────────────────────────────────────────────────

  it('returns passed when summary present and no signal/taskStatus', () => {
    expect(deriveFanOutLaneStatus({ summary: 'PASS: tests green' })).toBe('passed');
  });

  it('returns passed when summary present alongside irrelevant keys', () => {
    expect(deriveFanOutLaneStatus({ chatId: 'x', summary: 'ok', exitCode: 0 })).toBe('passed');
  });

  it('returns unknown when only non-summary keys present (e.g. chatId, exitCode)', () => {
    expect(deriveFanOutLaneStatus({ chatId: 'abc', exitCode: 0 })).toBe('unknown');
  });

  it('returns unknown for empty summary string (zero-length string is falsy check)', () => {
    // empty string → typeof is 'string' but length === 0 → falls to unknown
    expect(deriveFanOutLaneStatus({ summary: '' })).toBe('unknown');
  });

  // ──────────────────────────────────────────────────────────
  // Non-string / unexpected field types (defensive)
  // ──────────────────────────────────────────────────────────

  it('ignores non-string signal value', () => {
    expect(deriveFanOutLaneStatus({ signal: 42 })).toBe('unknown');
  });

  it('ignores non-string taskStatus value', () => {
    // should not throw; undefined taskStatus falls through
    expect(deriveFanOutLaneStatus({ taskStatus: null })).toBe('unknown');
  });
});
