import { describe, expect, it } from 'vitest';
import { truncateNodeOutput } from './truncate-node-output';

// ---------------------------------------------------------------------------
// EC2: Large _rawStdout truncation
// ---------------------------------------------------------------------------

describe('EC2: 500KB _rawStdout truncation', () => {
  it('truncates 500KB _rawStdout to within 8KB with truncated=true', () => {
    const bigStdout = 'x'.repeat(500 * 1024);
    const { outputs, truncated, fullSizeBytes } = truncateNodeOutput({ _rawStdout: bigStdout });

    expect(truncated).toBe(true);
    expect(fullSizeBytes).toBeGreaterThanOrEqual(500 * 1024);

    const resultJson = JSON.stringify(outputs);
    expect(Buffer.byteLength(resultJson, 'utf8')).toBeLessThanOrEqual(8192);
  });

  it('preserves tail content (last chars) for debugging', () => {
    const tail = 'FINAL_IMPORTANT_OUTPUT';
    const bigStdout = 'x'.repeat(100 * 1024) + tail;
    const { outputs } = truncateNodeOutput({ _rawStdout: bigStdout });

    const stdout = outputs._rawStdout as string;
    expect(stdout).toContain(tail);
  });
});

// ---------------------------------------------------------------------------
// EC3: Large HTTP response body truncation
// ---------------------------------------------------------------------------

describe('EC3: 256KB HTTP response body truncation', () => {
  it('truncates 256KB response body with truncation metadata', () => {
    const bigBody = 'a'.repeat(256 * 1024);
    const { outputs, truncated, fullSizeBytes } = truncateNodeOutput({
      body: bigBody,
      statusCode: 200,
    });

    expect(truncated).toBe(true);
    expect(fullSizeBytes).toBeGreaterThanOrEqual(256 * 1024);

    const resultJson = JSON.stringify(outputs);
    expect(Buffer.byteLength(resultJson, 'utf8')).toBeLessThanOrEqual(8192);
  });
});

// ---------------------------------------------------------------------------
// Normal-size outputs (no truncation)
// ---------------------------------------------------------------------------

describe('small outputs pass through unchanged', () => {
  it('returns outputs unchanged when within budget', () => {
    const outputs = { exitCode: 0, _rawStdout: 'small output' };
    const { outputs: result, truncated } = truncateNodeOutput(outputs);

    expect(truncated).toBe(false);
    expect(result).toEqual(outputs);
  });

  it('includes accurate fullSizeBytes when not truncated', () => {
    const outputs = { exitCode: 0 };
    const { truncated, fullSizeBytes } = truncateNodeOutput(outputs);

    expect(truncated).toBe(false);
    expect(fullSizeBytes).toBeGreaterThan(0);
    expect(fullSizeBytes).toBe(Buffer.byteLength(JSON.stringify(outputs), 'utf8'));
  });

  it('handles empty outputs without error', () => {
    const { outputs, truncated } = truncateNodeOutput({});
    expect(truncated).toBe(false);
    expect(outputs).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Custom maxBytes
// ---------------------------------------------------------------------------

describe('custom maxBytes', () => {
  it('respects a smaller maxBytes budget', () => {
    const outputs = { data: 'x'.repeat(200) };
    const { truncated } = truncateNodeOutput(outputs, 100);
    expect(truncated).toBe(true);
  });

  it('does not truncate when output is exactly at budget', () => {
    const outputs = { data: 'hello' };
    const full = JSON.stringify(outputs);
    const size = Buffer.byteLength(full, 'utf8');
    const { truncated } = truncateNodeOutput(outputs, size);
    expect(truncated).toBe(false);
  });
});
