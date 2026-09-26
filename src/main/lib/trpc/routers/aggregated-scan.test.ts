import { describe, expect, it, vi } from 'vitest';
import type { SkillTool } from '../../agents/follows-you';
import {
  aggregatedScan,
  dedupeByLogicalName,
  type RawEntry,
  type ScannedResource,
} from './aggregated-scan';

// Mock the I/O deps so `aggregatedScan`'s scan/project orchestration is unit-testable.
vi.mock('../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../db/repos/projects', () => ({
  listProjects: async () => [{ id: 'p1', path: '/proj' }],
}));
vi.mock('./agent-utils', () => ({
  resolveProjectCliTypesBatch: async () => new Map([['p1', 'cursor']]),
}));
const HOME = '/home/u';
const TOOLS: SkillTool[] = ['claude-code', 'cursor'];

/** Build a raw scanned entry whose path encodes its IDE dir (so deriveSourceFromPath classifies it). */
function entry(
  dir: '.claude' | '.cursor' | '.frink' | '.agents',
  name: string,
  opts: {
    scope?: 'global' | 'project';
    projectPath?: string;
    builtIn?: boolean;
    description?: string;
    cliType?: 'cursor' | 'claude-code';
  } = {},
): RawEntry<ScannedResource> {
  return {
    item: {
      name,
      path: `${HOME}/${dir}/skills/${name}/SKILL.md`,
      description: opts.description ?? `${name} desc`,
      ...(opts.builtIn && { builtIn: true }),
    },
    scope: opts.scope ?? 'global',
    ...(opts.projectPath && { projectPath: opts.projectPath }),
    ...(opts.cliType && { cliType: opts.cliType }),
  };
}

describe('dedupeByLogicalName — follows-you (read-map)', () => {
  it('in .claude+.cursor+.agents → follows you (every tool can read a copy)', () => {
    const rows = dedupeByLogicalName(
      [entry('.agents', 'graphify'), entry('.claude', 'graphify'), entry('.cursor', 'graphify')],
      'skill',
      TOOLS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].followsYou).toBe(true);
    expect(rows[0].sources?.map((s) => s.source)).toEqual(['claude-code', 'cursor']);
    expect('synced' in rows[0]).toBe(false);
  });

  it('.claude-only → STILL follows you (Cursor compat-reads .claude)', () => {
    const rows = dedupeByLogicalName([entry('.claude', 'foo')], 'skill', TOOLS);
    expect(rows[0].followsYou).toBe(true);
  });

  it('.cursor-only → gap: Claude cannot read .cursor → readableBy is just Cursor', () => {
    const rows = dedupeByLogicalName([entry('.cursor', 'foo')], 'skill', TOOLS);
    expect(rows[0].followsYou).toBe(false);
    expect(rows[0].readableBy).toEqual(['cursor']);
  });

  it('.agents-only → gap: Claude does NOT read .agents (the whole point)', () => {
    const rows = dedupeByLogicalName([entry('.agents', 'brainstorming')], 'skill', TOOLS);
    expect(rows[0].followsYou).toBe(false);
    expect(rows[0].readableBy).toEqual(['cursor']);
    expect(rows[0].sources).toBeUndefined(); // .agents is never a tool chip
  });

  it('a Cursor-only user: a .cursor-only skill DOES follow them', () => {
    const rows = dedupeByLogicalName([entry('.cursor', 'foo')], 'skill', ['cursor']);
    expect(rows[0].followsYou).toBe(true);
  });

  it('same-name in .claude + .cursor → ONE row, both paths reachable', () => {
    const rows = dedupeByLogicalName(
      [entry('.claude', 'foo'), entry('.cursor', 'foo')],
      'skill',
      TOOLS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sources?.map((s) => s.path)).toEqual([
      `${HOME}/.claude/skills/foo/SKILL.md`,
      `${HOME}/.cursor/skills/foo/SKILL.md`,
    ]);
  });

  it('divergent: same name DIFFERENT content → one row, both paths reachable (nothing hidden)', () => {
    const rows = dedupeByLogicalName(
      [
        entry('.claude', 'foo', { description: 'claude version' }),
        entry('.cursor', 'foo', { description: 'cursor version' }),
      ],
      'skill',
      TOOLS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toHaveLength(2);
  });

  it('.frink-only → no tool reads it → no chip, no gap, builtIn false', () => {
    const rows = dedupeByLogicalName([entry('.frink', 'foo')], 'skill', TOOLS);
    expect(rows[0].sources).toBeUndefined();
    expect(rows[0].readableBy).toBeUndefined();
    expect(rows[0].builtIn).toBe(false);
  });

  it('shipped built-in + user same-name copy → user copy stays editable (builtIn false)', () => {
    const rows = dedupeByLogicalName(
      [entry('.frink', 'frink-flows', { builtIn: true }), entry('.cursor', 'frink-flows')],
      'skill',
      TOOLS,
    );
    expect(rows[0].builtIn).toBe(false);
    expect(rows[0].sources?.map((s) => s.source)).toEqual(['cursor']);
  });

  it('a Frink-shipped built-in (all members builtIn) → builtIn true', () => {
    const rows = dedupeByLogicalName(
      [entry('.frink', 'frink-flows', { builtIn: true })],
      'skill',
      TOOLS,
    );
    expect(rows[0].builtIn).toBe(true);
  });

  it('Cursor project: canonical source is the active CLI (.cursor) so the sidebar filter keeps it', () => {
    const rows = dedupeByLogicalName(
      [
        entry('.claude', 'foo', { scope: 'project', projectPath: '/p', cliType: 'cursor' }),
        entry('.cursor', 'foo', { scope: 'project', projectPath: '/p', cliType: 'cursor' }),
      ],
      'skill',
      TOOLS,
    );
    expect(rows[0].config.source).toBe('cursor');
    expect(rows[0].sources?.map((s) => s.source)).toEqual(['cursor', 'claude-code']);
  });

  it('hooks never get chips, follows-you, or readableBy (dormant), even in .agents', () => {
    const rows = dedupeByLogicalName(
      [entry('.claude', 'h'), entry('.cursor', 'h'), entry('.agents', 'h')],
      'hook',
      TOOLS,
    );
    expect(rows[0].sources).toBeUndefined();
    expect(rows[0].followsYou).toBe(false);
    expect(rows[0].readableBy).toBeUndefined();
  });

  it('same resource name in two projects → separate rows (project-scope isolation)', () => {
    const rows = dedupeByLogicalName(
      [
        entry('.claude', 'foo', { scope: 'project', projectPath: '/p/one' }),
        entry('.claude', 'foo', { scope: 'project', projectPath: '/p/two' }),
      ],
      'skill',
      TOOLS,
    );
    expect(rows.map((r) => r.projectPath).sort()).toEqual(['/p/one', '/p/two']);
  });
});

describe('aggregatedScan (scan + project orchestration)', () => {
  // Return `foo` from any `.claude` or `.agents` dir (global home + the registered project).
  const scan = async (dir: string): Promise<ScannedResource[]> =>
    dir.includes('/.claude/') || dir.includes('/.agents/')
      ? [{ name: 'foo', path: `${dir}/foo/SKILL.md`, description: 'foo' }]
      : [];

  it('scans global + project dirs (incl. .agents), dedupes per scope, sets followsYou', async () => {
    const rows = await aggregatedScan('skill', 'skills', scan);

    const globalFoo = rows.find((r) => r.scope === 'global' && r.name === 'foo');
    expect(globalFoo).toBeDefined();
    // Present in ~/.claude + ~/.agents → readable by Claude (and Cursor) → follows you.
    expect(globalFoo?.followsYou).toBe(true);

    // The registered project's copy is a SEPARATE row, not merged into the global one.
    const projectFoo = rows.find((r) => r.scope === 'project' && r.name === 'foo');
    expect(projectFoo?.projectPath).toBe('/proj');
  });
});

describe('dedupeByLogicalName — AGENT read-map (Cursor does NOT read .claude/agents)', () => {
  it('a .claude-only AGENT is NOT "Synced" for a Claude+Cursor user (skills would be — BUG-6)', () => {
    const rows = dedupeByLogicalName([entry('.claude', 'reviewer')], 'agent', TOOLS);
    expect(rows[0].followsYou).toBe(false); // Cursor can't read .claude/agents → the gap the copy fixes
    expect(rows[0].readableBy).toEqual(['claude-code']);
  });

  it('an agent in .claude + .cursor follows you', () => {
    const rows = dedupeByLogicalName(
      [entry('.claude', 'reviewer'), entry('.cursor', 'reviewer')],
      'agent',
      TOOLS,
    );
    expect(rows[0].followsYou).toBe(true);
  });
});
