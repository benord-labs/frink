/**
 * Tests for parse-node-output.ts shared utilities.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTestResult,
  MAX_PARSED_OUTPUT_CHARS,
  MAX_RAW_FALLBACK_BYTES,
  MAX_STDOUT_PARSE_BYTES,
  parseStructuredStdout,
} from './parse-node-output';

describe('parseStructuredStdout', () => {
  it('parses a valid flat JSON object', () => {
    const result = parseStructuredStdout('{"count":3,"hasNewPRs":true}');
    expect(result).toEqual({ count: 3, hasNewPRs: true });
  });

  it('returns null for empty string', () => {
    expect(parseStructuredStdout('')).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(parseStructuredStdout('[1,2,3]')).toBeNull();
  });

  it('returns null for a JSON string', () => {
    expect(parseStructuredStdout('"hello"')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(parseStructuredStdout('null')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseStructuredStdout('not json at all')).toBeNull();
  });

  it('returns {} for empty JSON object', () => {
    expect(parseStructuredStdout('{}')).toEqual({});
  });

  it('returns null when stdout exceeds MAX_STDOUT_PARSE_BYTES', () => {
    const huge = `{"x":"${'a'.repeat(MAX_STDOUT_PARSE_BYTES)}"}`;
    expect(huge.length).toBeGreaterThan(MAX_STDOUT_PARSE_BYTES);
    expect(parseStructuredStdout(huge)).toBeNull();
  });
});

describe('buildTestResult', () => {
  it('returns parsedOutput for valid JSON stdout', () => {
    const result = buildTestResult({ stdout: '{"count":3}', stderr: '', exitCode: 0 }, 100);
    expect(result.exitCode).toBe(0);
    expect(result.parsedOutput).toEqual({ count: 3 });
    expect(result.durationMs).toBe(100);
    expect(result.warning).toContain('same bundled Node.js execution path');
  });

  it('returns null parsedOutput when stdout is not JSON', () => {
    const result = buildTestResult({ stdout: 'plain text', stderr: '', exitCode: 0 }, 50);
    expect(result.parsedOutput).toBeNull();
  });

  it('truncates stdout to MAX_RAW_FALLBACK_BYTES', () => {
    const longStdout = 'x'.repeat(MAX_RAW_FALLBACK_BYTES + 100);
    const result = buildTestResult({ stdout: longStdout, stderr: '', exitCode: 0 }, 10);
    expect(result.stdout.length).toBe(MAX_RAW_FALLBACK_BYTES);
  });

  it('truncates stderr to 1000 chars', () => {
    const longStderr = 'e'.repeat(2000);
    const result = buildTestResult({ stdout: '', stderr: longStderr, exitCode: 1 }, 10);
    expect(result.stderr.length).toBe(1000);
  });

  it('includes exitCode in result', () => {
    const result = buildTestResult({ stdout: '', stderr: 'error', exitCode: 1 }, 0);
    expect(result.exitCode).toBe(1);
  });

  it('handles null exitCode from a bundled Node.js start failure or timeout', () => {
    const result = buildTestResult(
      {
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: true,
        spawnMessage: `Frink's bundled Node.js could not start custom node "example".`,
      },
      0,
    );
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.spawnMessage).toContain('bundled Node.js could not start');
  });

  it('caps parsedOutput to MAX_PARSED_OUTPUT_CHARS — returns null when serialized output is too large', () => {
    // MEDIUM #4: parsedOutput is returned directly in the MCP tool response. A large JSON
    // object (e.g. hundreds of PRs with many fields) could inject thousands of tokens into
    // the agent context on every test iteration. parsedOutput must be capped.
    const largeItems = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      title: `Pull Request ${i}: some fairly long title that adds tokens`,
      body: 'x'.repeat(50),
      headRefName: `sc-${i}-feature-branch`,
    }));
    const largeJson = JSON.stringify({ count: 500, items: largeItems });
    expect(largeJson.length).toBeGreaterThan(MAX_PARSED_OUTPUT_CHARS);

    const result = buildTestResult({ stdout: largeJson, stderr: '', exitCode: 0 }, 100);
    // parsedOutput must be null when the output is too large to surface inline
    expect(result.parsedOutput).toBeNull();
    // warning should tell the agent why
    expect(result.warning).toMatch(/parsedOutput|large|truncat/i);
  });

  it('returns parsedOutput when serialized output is within MAX_PARSED_OUTPUT_CHARS', () => {
    const smallJson = JSON.stringify({ count: 3, items: ['a', 'b', 'c'] });
    expect(smallJson.length).toBeLessThanOrEqual(MAX_PARSED_OUTPUT_CHARS);
    const result = buildTestResult({ stdout: smallJson, stderr: '', exitCode: 0 }, 50);
    expect(result.parsedOutput).toEqual({ count: 3, items: ['a', 'b', 'c'] });
  });
});
