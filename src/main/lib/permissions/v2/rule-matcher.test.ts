import { describe, expect, it } from 'vitest';
import { extractCommandSignatures } from '../command-parser';
import { matchesRule } from './rule-matcher';
import type { BashCommandSignature } from './types';

function bashSig(command: string): BashCommandSignature {
  // Use the production extractor so tests reflect real call-site behaviour.
  // For chained commands, return the first signature (matcher takes one at a time).
  const sigs = extractCommandSignatures(command);
  if (sigs.length === 0) {
    throw new Error(`extractCommandSignatures returned nothing for "${command}"`);
  }
  return sigs[0];
}

function bashSigs(command: string): BashCommandSignature[] {
  return extractCommandSignatures(command);
}

describe('matchesRule — tool-wide', () => {
  it('matches any input for the named tool', () => {
    expect(matchesRule('Bash', 'Bash', { command: 'anything' })).toBe(true);
    expect(matchesRule('Edit', 'Edit', { file_path: '/x' })).toBe(true);
  });

  it('rejects different tool names', () => {
    expect(matchesRule('Bash', 'Edit', { file_path: '/x' })).toBe(false);
  });

  it('Edit(*) shortcut == tool-wide (does not call picomatch)', () => {
    expect(matchesRule('Edit(*)', 'Edit', {})).toBe(true);
    expect(matchesRule('Bash(*)', 'Bash', { command: 'anything' })).toBe(true);
  });
});

describe('matchesRule — Bash content', () => {
  it('prefix wildcard matches single base', () => {
    expect(
      matchesRule(
        'Bash(npm:*)',
        'Bash',
        { command: 'npm test' },
        {
          bashCommandSignature: bashSig('npm test'),
        },
      ),
    ).toBe(true);
  });

  it('prefix wildcard rejects different base', () => {
    expect(
      matchesRule(
        'Bash(npm:*)',
        'Bash',
        { command: 'npmx test' },
        {
          bashCommandSignature: bashSig('npmx test'),
        },
      ),
    ).toBe(false);
  });

  it('compound prefix matches subcommand', () => {
    expect(
      matchesRule(
        'Bash(git push:*)',
        'Bash',
        { command: 'git push origin main' },
        {
          bashCommandSignature: bashSig('git push origin main'),
        },
      ),
    ).toBe(true);
  });

  it('compound prefix rejects different subcommand', () => {
    expect(
      matchesRule(
        'Bash(git push:*)',
        'Bash',
        { command: 'git pull' },
        {
          bashCommandSignature: bashSig('git pull'),
        },
      ),
    ).toBe(false);
  });

  it('exact content matches', () => {
    expect(
      matchesRule(
        'Bash(echo hello)',
        'Bash',
        { command: 'echo hello' },
        {
          bashCommandSignature: bashSig('echo hello'),
        },
      ),
    ).toBe(true);
  });

  it('exact content rejects different command', () => {
    expect(
      matchesRule(
        'Bash(echo hello)',
        'Bash',
        { command: 'echo world' },
        {
          bashCommandSignature: bashSig('echo world'),
        },
      ),
    ).toBe(false);
  });

  it('safe-fails when signature is missing', () => {
    expect(matchesRule('Bash(npm:*)', 'Bash', { command: 'npm test' })).toBe(false);
  });

  it('chained command matches per-signature (any-match contract)', () => {
    // Compound `git add . && git push` produces 2 signatures. Matcher takes one
    // at a time — caller (ticket 05 dispatcher) decides aggregation policy.
    const sigs = bashSigs('git add . && git push origin main');
    expect(sigs).toHaveLength(2);
    // Rule matches the `git push` signature only.
    expect(
      matchesRule(
        'Bash(git push:*)',
        'Bash',
        { command: '' },
        {
          bashCommandSignature: sigs[1],
        },
      ),
    ).toBe(true);
    // Same rule against the `git add` signature → false.
    expect(
      matchesRule(
        'Bash(git push:*)',
        'Bash',
        { command: '' },
        {
          bashCommandSignature: sigs[0],
        },
      ),
    ).toBe(false);
  });
});

describe('matchesRule — path globs', () => {
  it('Edit(src/**) matches any path under src/ via resolvedPath', () => {
    expect(
      matchesRule(
        'Edit(src/**)',
        'Edit',
        { file_path: 'src/a/b.ts' },
        {
          resolvedPath: 'src/a/b.ts',
        },
      ),
    ).toBe(true);
  });

  it('Edit(src/**) rejects path outside src/', () => {
    expect(
      matchesRule(
        'Edit(src/**)',
        'Edit',
        { file_path: 'lib/x.ts' },
        {
          resolvedPath: 'lib/x.ts',
        },
      ),
    ).toBe(false);
  });

  it('falls back to file_path when resolvedPath missing', () => {
    expect(matchesRule('Edit(src/**)', 'Edit', { file_path: 'src/a.ts' })).toBe(true);
  });

  it('Edit(**) globstar matches any path', () => {
    expect(matchesRule('Edit(**)', 'Edit', { file_path: 'src/a.ts' })).toBe(true);
    expect(matchesRule('Edit(**)', 'Edit', { file_path: 'lib/deep/x.ts' })).toBe(true);
  });

  it('returns false when no path can be resolved', () => {
    expect(matchesRule('Edit(src/**)', 'Edit', {})).toBe(false);
  });
});

describe('matchesRule — MCP', () => {
  it('mcp__shortcut__* matches any tool on shortcut server', () => {
    expect(matchesRule('mcp__shortcut__*', 'mcp__shortcut__create_story', {})).toBe(true);
    expect(matchesRule('mcp__shortcut__*', 'mcp__shortcut__update_story', {})).toBe(true);
  });

  it('mcp__shortcut__* rejects different server', () => {
    expect(matchesRule('mcp__shortcut__*', 'mcp__github__create_issue', {})).toBe(false);
  });

  it('uses exact MCP provenance for server wildcards', () => {
    const identity = { server: 'frink__evil', tool: 'x' };
    expect(matchesRule('mcp__frink__*', 'mcp__frink__evil__x', {}, { mcpIdentity: identity })).toBe(
      false,
    );
    expect(
      matchesRule('mcp__frink__evil__*', 'mcp__frink__evil__x', {}, { mcpIdentity: identity }),
    ).toBe(true);
  });

  it('fails closed for ambiguous exact MCP identities', () => {
    expect(
      matchesRule(
        'mcp__frink__evil__x',
        'mcp__frink__evil__x',
        {},
        {
          mcpIdentity: { server: 'frink__evil', tool: 'x' },
        },
      ),
    ).toBe(false);
  });

  it('matches exact MCP rules against raw provenance, not sanitized names', () => {
    const flattened = 'mcp__foo_bar__x';
    expect(
      matchesRule(
        'mcp__foo_bar__x',
        flattened,
        {},
        {
          mcpIdentity: { server: 'foo-bar', tool: 'x' },
        },
      ),
    ).toBe(false);
    expect(
      matchesRule(
        'mcp__foo-bar__x',
        flattened,
        {},
        {
          mcpIdentity: { server: 'foo-bar', tool: 'x' },
        },
      ),
    ).toBe(true);
  });

  it('does not reinterpret raw MCP tool punctuation as rule syntax', () => {
    expect(
      matchesRule(
        'mcp__s__delete(*)',
        'mcp__s__delete(*)',
        {},
        {
          mcpIdentity: { server: 's', tool: 'delete(*)' },
        },
      ),
    ).toBe(false);
  });

  it('mcp__shortcut__create_story matches exact tool', () => {
    expect(matchesRule('mcp__shortcut__create_story', 'mcp__shortcut__create_story', {})).toBe(
      true,
    );
  });

  it('mcp__shortcut__create_story rejects different tool', () => {
    expect(matchesRule('mcp__shortcut__create_story', 'mcp__shortcut__update_story', {})).toBe(
      false,
    );
  });

  it('matches exact MCP resource methods without colliding with callable tools', () => {
    expect(matchesRule('mcp__context7__resources/read', 'mcp__context7__resources/read', {})).toBe(
      true,
    );
    expect(
      matchesRule('mcp__context7__read_mcp_resource', 'mcp__context7__resources/read', {}),
    ).toBe(false);
  });
});

describe('matchesRule — path tools beyond Edit', () => {
  it('Read(src/**) matches', () => {
    expect(matchesRule('Read(src/**)', 'Read', { file_path: 'src/a.ts' })).toBe(true);
  });

  it('Write(src/**) matches', () => {
    expect(matchesRule('Write(src/**)', 'Write', { file_path: 'src/a.ts' })).toBe(true);
  });

  it('Read falls back to obj.path when file_path missing', () => {
    expect(matchesRule('Read(src/**)', 'Read', { path: 'src/a.ts' })).toBe(true);
  });

  it('Write falls back to obj.file when file_path missing', () => {
    expect(matchesRule('Write(src/**)', 'Write', { file: 'src/a.ts' })).toBe(true);
  });
});

describe('matchesRule — case sensitivity', () => {
  it('tool names are case-sensitive', () => {
    expect(matchesRule('Bash', 'bash', { command: 'x' })).toBe(false);
    expect(matchesRule('Mcp__shortcut__*', 'mcp__shortcut__create_story', {})).toBe(false);
  });
});

describe('matchesRule — Windows path separator normalization (ticket 15 edge case)', () => {
  // `nodePath.relative` on Windows returns OS-native separators (`src\x.ts`).
  // Rule strings are authored in POSIX form (`Read(src/**)`). The matcher MUST
  // normalize before invoking picomatch, otherwise Windows users get silent
  // rule-miss for every path-globbed file-op rule.

  it('Edit(src/**) matches backslash-separated resolvedPath (Windows-style)', () => {
    expect(
      matchesRule(
        'Edit(src/**)',
        'Edit',
        { file_path: 'src/a/b.ts' },
        { resolvedPath: 'src\\a\\b.ts' },
      ),
    ).toBe(true);
  });

  it('Edit(src/a.ts) matches exact backslash path', () => {
    expect(
      matchesRule(
        'Edit(src/a.ts)',
        'Edit',
        { file_path: 'src/a.ts' },
        { resolvedPath: 'src\\a.ts' },
      ),
    ).toBe(true);
  });

  it('Read(src/**) matches backslash resolvedPath under Read tool', () => {
    expect(
      matchesRule('Read(src/**)', 'Read', { file_path: 'src/x.ts' }, { resolvedPath: 'src\\x.ts' }),
    ).toBe(true);
  });

  it('falls back to file_path containing backslashes when resolvedPath missing', () => {
    // tool input itself may carry Windows-native separators (e.g. when the
    // dispatcher passes absolute Windows paths through unchanged).
    expect(matchesRule('Edit(src/**)', 'Edit', { file_path: 'src\\a.ts' })).toBe(true);
  });

  it('Edit(src/**) rejects backslash path outside src/', () => {
    expect(
      matchesRule('Edit(src/**)', 'Edit', { file_path: 'lib/x.ts' }, { resolvedPath: 'lib\\x.ts' }),
    ).toBe(false);
  });
});

describe('matchesRule — error handling', () => {
  it('returns false (not throw) on parse error', () => {
    expect(matchesRule('garbage(', 'Bash', { command: 'x' })).toBe(false);
    expect(matchesRule('', 'Bash', { command: 'x' })).toBe(false);
  });
});

describe('matchesRule — generic content (non-bash, non-path)', () => {
  it('matches stringified command field for unknown tools', () => {
    expect(matchesRule('Custom(do-thing)', 'Custom', { command: 'do-thing' })).toBe(true);
    expect(matchesRule('Custom(do-thing)', 'Custom', { command: 'other' })).toBe(false);
  });
});
