import { describe, expect, it } from 'vitest';
import { parseNodeOutput } from './parse-node-output';

describe('parseNodeOutput', () => {
  it('returns success for a minimal valid envelope', () => {
    const r = parseNodeOutput({
      status: 'completed',
      outputs: { exitCode: 0 },
      artifacts: [],
      durationMs: 42,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.output.status).toBe('completed');
      expect(r.output.outputs.exitCode).toBe(0);
      expect(r.output.durationMs).toBe(42);
    }
  });

  it('returns success when artifacts omitted (defaults empty)', () => {
    const r = parseNodeOutput({
      status: 'failed',
      outputs: {},
      durationMs: 0,
      error: { message: 'oops', retryable: true },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.output.error?.message).toBe('oops');
      expect(r.output.artifacts).toEqual([]);
    }
  });

  it('returns failure for null', () => {
    const r = parseNodeOutput(null);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.raw).toBeNull();
  });

  it('returns failure for malformed payload', () => {
    const r = parseNodeOutput({ foo: 1 } as Record<string, unknown>);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.raw).toEqual({ foo: 1 });
  });

  it('treats empty error message as valid parse (UI shows Unknown error)', () => {
    const r = parseNodeOutput({
      status: 'failed',
      outputs: {},
      durationMs: 0,
      error: { message: '', retryable: false },
    });
    expect(r.success).toBe(true);
  });
});
