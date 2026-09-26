import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { normalizeSpawnShape } from './spawn-shape';

describe('normalizeSpawnShape', () => {
  it('splits a smushed command (Railway: full shell line in command, empty args)', () => {
    const result = normalizeSpawnShape('npx -y @railway/mcp-server', []);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@railway/mcp-server']);
    expect(result.rewrites).toEqual(['command-split']);
  });

  it('prepends -y when npx is invoked without it (RunPod)', () => {
    const result = normalizeSpawnShape('npx', ['@runpod/mcp-server@latest']);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@runpod/mcp-server@latest']);
    expect(result.rewrites).toEqual(['npx-auto-yes']);
  });

  it('leaves npx with -y unchanged', () => {
    const result = normalizeSpawnShape('npx', ['-y', 'pkg']);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', 'pkg']);
    expect(result.rewrites).toEqual([]);
  });

  it('leaves npx with --yes unchanged', () => {
    const result = normalizeSpawnShape('npx', ['--yes', 'pkg']);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['--yes', 'pkg']);
    expect(result.rewrites).toEqual([]);
  });

  it('splits args when command is fine but args is one smushed element', () => {
    const result = normalizeSpawnShape('npx', ['-y firecrawl-mcp']);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', 'firecrawl-mcp']);
    expect(result.rewrites).toEqual(['args-split']);
  });

  it('does NOT split a real file path with spaces (interpreter script)', () => {
    // Create a tmp dir whose name contains spaces so the test is deterministic
    // across OS / CI (CI runners under `/home/runner/...` have no spaces in
    // their path, which would silently no-op a `__filename`-based check).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn shape '));
    const filePath = path.join(dir, 'script.js');
    fs.writeFileSync(filePath, '');
    try {
      expect(filePath).toMatch(/\s/);
      const result = normalizeSpawnShape('node', [filePath]);
      expect(result.command).toBe('node');
      expect(result.args).toEqual([filePath]);
      expect(result.rewrites).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT split a real self-executing script path with spaces in command (empty args)', () => {
    // A shebang script registered as `command` with no args is indistinguishable
    // from a shell line by shape alone — only existence on disk separates them.
    // Without the check the path is shredded at the first space and the MCP
    // never appears in the session at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn command '));
    const filePath = path.join(dir, 'server.js');
    fs.writeFileSync(filePath, '#!/usr/bin/env node\n');
    try {
      expect(filePath).toMatch(/\s/);
      const result = normalizeSpawnShape(filePath, []);
      expect(result.command).toBe(filePath);
      expect(result.args).toEqual([]);
      expect(result.rewrites).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still splits a shell line in command when a cwd is supplied (production call shape)', () => {
    // Both callers always pass a third argument, so the `!cwd` short-circuit
    // never runs in production. Without this, every command-split test would
    // stay green while a change to the resolution base silently broke the one
    // live shell-line MCP config.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn split cwd '));
    try {
      const result = normalizeSpawnShape('npx -y @shortcut/mcp', [], dir);
      expect(result.command).toBe('npx');
      expect(result.args).toEqual(['-y', '@shortcut/mcp']);
      expect(result.rewrites).toEqual(['command-split']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative command path-with-spaces against cwd (does not split)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn cmd cwd '));
    const subdir = path.join(dir, 'my server');
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, 'run.js'), '');
    try {
      const result = normalizeSpawnShape('./my server/run.js', [], dir);
      expect(result.command).toBe('./my server/run.js');
      expect(result.args).toEqual([]);
      expect(result.rewrites).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still splits a non-existent path-shaped string with spaces (legacy args-split preserved)', () => {
    // Negative-path companion to the existing-file test above. Ensures the
    // fs.existsSync skip does not change behaviour for path-shaped strings
    // that don't resolve to a real file — those still go through shell-quote
    // splitting (matches the original args-split intent for cursor configs
    // that packed flags + name into a single element).
    const result = normalizeSpawnShape('node', ['/definitely/not/a/real path/that/exists.js']);
    expect(result.command).toBe('node');
    expect(result.args).toEqual(['/definitely/not/a/real', 'path/that/exists.js']);
    expect(result.rewrites).toEqual(['args-split']);
  });

  it('resolves relative paths-with-spaces against caller-supplied cwd (does not split)', () => {
    // Relative-path MCP configs (e.g. `./scripts/my server/run.js`) must be
    // resolved against the MCP's configured `cwd`, not Frink's app process.
    // Without the `cwd` parameter the relative path would be falsely treated
    // as non-existent and shredded by shell-quote.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn cwd '));
    const subdir = path.join(dir, 'my server');
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, 'run.js'), '');
    try {
      const result = normalizeSpawnShape('node', ['./my server/run.js'], dir);
      expect(result.command).toBe('node');
      expect(result.args).toEqual(['./my server/run.js']);
      expect(result.rewrites).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles quoted paths with spaces (shell-quote tokenization, not naive split)', () => {
    const result = normalizeSpawnShape("node '/path with spaces/foo.js'", []);
    expect(result.command).toBe('node');
    expect(result.args).toEqual(['/path with spaces/foo.js']);
    expect(result.rewrites).toEqual(['command-split']);
  });

  it('bails on shell operators (pipes), leaving input unchanged', () => {
    const result = normalizeSpawnShape('echo foo | grep bar', []);
    expect(result.command).toBe('echo foo | grep bar');
    expect(result.args).toEqual([]);
    expect(result.rewrites).toEqual([]);
  });

  it('does not touch a single-token command (Memory, normal case)', () => {
    const result = normalizeSpawnShape('npx', ['-y', '@modelcontextprotocol/server-memory']);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@modelcontextprotocol/server-memory']);
    expect(result.rewrites).toEqual([]);
  });

  it('handles empty command without crashing', () => {
    const result = normalizeSpawnShape('', []);
    expect(result.command).toBe('');
    expect(result.args).toEqual([]);
    expect(result.rewrites).toEqual([]);
  });

  it('leaves an absolute path command unchanged when it has no whitespace', () => {
    const result = normalizeSpawnShape('/Users/x/.local/bin/foo', []);
    expect(result.command).toBe('/Users/x/.local/bin/foo');
    expect(result.args).toEqual([]);
    expect(result.rewrites).toEqual([]);
  });

  it('matches /usr/local/bin/npx as npx for the auto-yes rewrite', () => {
    const result = normalizeSpawnShape('/usr/local/bin/npx', ['pkg']);
    expect(result.command).toBe('/usr/local/bin/npx');
    expect(result.args).toEqual(['-y', 'pkg']);
    expect(result.rewrites).toEqual(['npx-auto-yes']);
  });

  it('combines command-split with npx-auto-yes when smushed npx command lacks -y', () => {
    const result = normalizeSpawnShape('npx @runpod/mcp-server@latest', []);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@runpod/mcp-server@latest']);
    expect(result.rewrites).toEqual(['command-split', 'npx-auto-yes']);
  });

  it('does not touch args when more than one element and none contain spaces', () => {
    const result = normalizeSpawnShape('uvx', ['--from', 'somewhere', 'pkg']);
    expect(result.command).toBe('uvx');
    expect(result.args).toEqual(['--from', 'somewhere', 'pkg']);
    expect(result.rewrites).toEqual([]);
  });

  // Edge: copy-paste from a shell often leaves a trailing space on the
  // command. Without trim, `command === 'npx'` is false and the auto-yes
  // rewrite silently misses, leaving a real-world MCP broken on spawn.
  it('strips trailing whitespace before checking for npx auto-yes', () => {
    const result = normalizeSpawnShape('npx ', ['pkg']);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', 'pkg']);
    expect(result.rewrites).toEqual(['npx-auto-yes']);
  });

  // Edge: leading whitespace from the same source — same fix.
  it('strips leading whitespace before normalizing', () => {
    const result = normalizeSpawnShape('  npx -y @pkg', []);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@pkg']);
    expect(result.rewrites).toEqual(['command-split']);
  });

  // Edge: tab-separated command. shell-quote tokenizes on any whitespace,
  // but our entry condition only checks for ' '. A tab-only command would
  // never be parsed → never split → ENOENT at spawn time.
  it('splits a command with tab-separated tokens', () => {
    const result = normalizeSpawnShape('npx\t-y\t@pkg', []);
    expect(result.command).toBe('npx');
    expect(result.args).toEqual(['-y', '@pkg']);
    expect(result.rewrites).toEqual(['command-split']);
  });

  // Invariant: the helper must be idempotent. If a future caller (or a
  // multi-pane chat that reuses cached SDK payloads) invokes normalize
  // twice on the same input, the second call must be a no-op rewrites-wise
  // and yield identical command/args. Proves no rewrite "compounds" (e.g.
  // `-y` getting prepended twice).
  it('is idempotent: re-normalizing the output produces no further rewrites', () => {
    const first = normalizeSpawnShape('npx @runpod/mcp-server@latest', []);
    expect(first.rewrites).toEqual(['command-split', 'npx-auto-yes']);
    const second = normalizeSpawnShape(first.command, first.args);
    expect(second.command).toBe(first.command);
    expect(second.args).toEqual(first.args);
    expect(second.rewrites).toEqual([]);
  });
});
