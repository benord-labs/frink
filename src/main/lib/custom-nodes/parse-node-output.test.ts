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
  summarizeStderr,
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

describe('summarizeStderr: shell failures with no error keyword', () => {
  // Captured on macOS (sh, zsh, dash, bash, cat, python); busybox and cmd.exe rows are their documented messages.
  it.each([
    [
      'sh',
      'building\n/bin/sh: nosuchcmd: command not found\n',
      '/bin/sh: nosuchcmd: command not found',
    ],
    [
      'zsh',
      'building\nzsh:1: command not found: nosuchcmd\n',
      'zsh:1: command not found: nosuchcmd',
    ],
    ['dash', 'building\ndash: 1: nosuchcmd: not found\n', 'dash: 1: nosuchcmd: not found'],
    ['busybox', 'building\n/bin/sh: nosuchcmd: not found\n', '/bin/sh: nosuchcmd: not found'],
    [
      'bash',
      'building\nbash: line 1: /tmp/job.sh: Permission denied\n',
      'bash: line 1: /tmp/job.sh: Permission denied',
    ],
    [
      'cat',
      'building\ncat: /tmp/missing: No such file or directory\n',
      'cat: /tmp/missing: No such file or directory',
    ],
    [
      'python',
      "building\npython3: can't open file '/tmp/job.py': [Errno 2] No such file or directory\n",
      "python3: can't open file '/tmp/job.py': [Errno 2] No such file or directory",
    ],
    [
      'cmd.exe unknown command',
      "building\r\n'nosuchcmd' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
      "'nosuchcmd' is not recognized as an internal or external command,",
    ],
    [
      'cmd.exe missing path',
      'building\r\nThe system cannot find the path specified.\r\n',
      'The system cannot find the path specified.',
    ],
    [
      'cmd.exe missing file',
      'building\r\nThe system cannot find the file specified.\r\n',
      'The system cannot find the file specified.',
    ],
    ['cmd.exe access denied', 'building\r\nAccess is denied.\r\n', 'Access is denied.'],
  ])('%s: leads with the failure line, not the progress line', (_shell, stderr, cause) => {
    expect(summarizeStderr(stderr)).toBe(`${cause} — building`);
  });

  it('keeps a keyword cause ahead of later shell-failure cleanup noise', () => {
    const stderr = 'Error: db connection refused\nrm: ./job.lock: No such file or directory\n';
    expect(summarizeStderr(stderr)).toBe('Error: db connection refused');
  });

  it('leads with the first shell failure, not cleanup noise printed after it', () => {
    const stderr =
      'building\n/bin/sh: nosuchcmd: command not found\nrm: ./job.lock: No such file or directory\n';
    expect(summarizeStderr(stderr)).toBe('/bin/sh: nosuchcmd: command not found — building');
  });

  it.each([
    [
      'a command that cannot run over an earlier tolerated missing file',
      'building\nls: missing-file: No such file or directory\n/bin/sh: nosuchcmd: command not found\n',
      '/bin/sh: nosuchcmd: command not found — building',
    ],
    [
      'a refused command over an earlier tolerated missing file',
      'building\nls: missing-file: No such file or directory\nbash: line 2: ./deploy.sh: Permission denied\n',
      'bash: line 2: ./deploy.sh: Permission denied — building',
    ],
    [
      'the first of a cascade of missing files',
      'building\nbash: line 1: cd: build: No such file or directory\ncat: out.txt: No such file or directory\n',
      'bash: line 1: cd: build: No such file or directory — building',
    ],
  ])('leads with %s', (_case, stderr, summary) => {
    expect(summarizeStderr(stderr)).toBe(summary);
  });

  it.each([
    ['a phrase mid-line', 'warning: permission denied for cache, retrying'],
    ['"not found" without a shell name', 'module: api: not found'],
  ])('does not treat %s as a shell failure', (_case, line) => {
    expect(summarizeStderr(`building\n${line}\nstep 2 done\n`)).toBe('building');
  });
});
