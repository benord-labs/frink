import { describe, expect, it } from 'vitest';
import {
  agentCopyDirs,
  BRIDGED_TOOLS,
  followsYouAcross,
  readableBy,
  type SkillTool,
  skillCopyDirs,
} from './follows-you';

const TOOLS: SkillTool[] = ['claude-code', 'cursor'];
const p = (dir: string) => `/home/u/${dir}/skills/x/SKILL.md`;

describe('readableBy / followsYouAcross (read-map)', () => {
  it('.claude copy is readable by BOTH (Cursor compat-reads .claude) → follows you', () => {
    const paths = [p('.claude')];
    expect(readableBy(paths, TOOLS)).toEqual(['claude-code', 'cursor']);
    expect(followsYouAcross(paths, TOOLS)).toBe(true);
  });

  it('.cursor-only → Claude cannot read it → gap (only Cursor)', () => {
    const paths = [p('.cursor')];
    expect(readableBy(paths, TOOLS)).toEqual(['cursor']);
    expect(followsYouAcross(paths, TOOLS)).toBe(false);
  });

  it('.agents-only → Claude does NOT read .agents → gap (only Cursor)', () => {
    const paths = [p('.agents')];
    expect(readableBy(paths, TOOLS)).toEqual(['cursor']);
    expect(followsYouAcross(paths, TOOLS)).toBe(false);
  });

  it('.frink-only → no tool reads it', () => {
    expect(readableBy([p('.frink')], TOOLS)).toEqual([]);
    expect(followsYouAcross([p('.frink')], TOOLS)).toBe(false);
  });

  it('a Cursor-only user: a .cursor copy follows them', () => {
    expect(followsYouAcross([p('.cursor')], ['cursor'])).toBe(true);
  });

  it('a Claude-only user: a .cursor-only skill is readable by NONE of their tools', () => {
    expect(readableBy([p('.cursor')], ['claude-code'])).toEqual([]);
    expect(followsYouAcross([p('.cursor')], ['claude-code'])).toBe(false);
  });

  it('no configured tools → never claims to follow', () => {
    expect(followsYouAcross([p('.claude')], [])).toBe(false);
  });
});

describe('BRIDGED_TOOLS', () => {
  it('carries Cursor even though Frink does not run it, so the bridge keeps projecting', () => {
    expect(BRIDGED_TOOLS).toEqual(['claude-code', 'cursor']);
    expect(agentCopyDirs('portable', BRIDGED_TOOLS)).toEqual(['.claude', '.cursor']);
  });
});

describe('OS path handling (Windows backslash separators)', () => {
  const win = (dir: string) => `C:\\Users\\u\\${dir}\\skills\\x\\SKILL.md`;

  it('classifies a .claude Windows path → readable by both, follows you', () => {
    expect(readableBy([win('.claude')], TOOLS)).toEqual(['claude-code', 'cursor']);
    expect(followsYouAcross([win('.claude')], TOOLS)).toBe(true);
  });

  it('classifies a .cursor Windows path → Claude cannot read it (gap)', () => {
    expect(readableBy([win('.cursor')], TOOLS)).toEqual(['cursor']);
    expect(followsYouAcross([win('.cursor')], TOOLS)).toBe(false);
  });
});

describe('skillCopyDirs (copy breadth)', () => {
  it('portable gap-fills: .agents + .claude (Claude can’t read .agents), never .cursor', () => {
    // Cursor already reads .agents, so its native dir is redundant — the set must omit it.
    expect(skillCopyDirs('portable', TOOLS)).toEqual(['.agents', '.claude']);
  });

  it('portable for a Cursor-only user is just .agents (Cursor reads it)', () => {
    expect(skillCopyDirs('portable', ['cursor'])).toEqual(['.agents']);
  });

  it('native writes only the active tool’s own dir', () => {
    expect(skillCopyDirs('native', TOOLS, 'claude-code')).toEqual(['.claude']);
    expect(skillCopyDirs('native', TOOLS, 'cursor')).toEqual(['.cursor']);
  });

  it('native with no active tool yields nothing (caller guards against a no-op copy)', () => {
    expect(skillCopyDirs('native', TOOLS)).toEqual([]);
  });
});

describe('agentCopyDirs (agent read-map ≠ skill read-map)', () => {
  it('portable = each configured tool’s native agents dir, and NEVER .agents (no agent reads it)', () => {
    // The skills map lets Cursor read .agents; for agents there is no such dir, so portable must write
    // .cursor (else the copy is invisible to Cursor) and must NOT write .agents (nothing would read it).
    expect(agentCopyDirs('portable', TOOLS)).toEqual(['.claude', '.cursor']);
  });

  it('portable for a Cursor-only user is .cursor (NOT .agents like skills)', () => {
    expect(agentCopyDirs('portable', ['cursor'])).toEqual(['.cursor']);
  });

  it('native writes only the active tool’s own agents dir', () => {
    expect(agentCopyDirs('native', TOOLS, 'claude-code')).toEqual(['.claude']);
    expect(agentCopyDirs('native', TOOLS, 'cursor')).toEqual(['.cursor']);
  });

  it('native with no active tool yields nothing', () => {
    expect(agentCopyDirs('native', TOOLS)).toEqual([]);
  });
});

describe('agent read-map (kind="agent") — Cursor does NOT read .claude/agents', () => {
  const ap = (dir: string) => `/home/u/${dir}/agents/x.md`;

  it('a .claude-only agent is readable by Claude but NOT Cursor (the skill-map would lie)', () => {
    expect(readableBy([ap('.claude')], TOOLS, 'agent')).toEqual(['claude-code']);
    expect(followsYouAcross([ap('.claude')], TOOLS, 'agent')).toBe(false);
    // Contrast: as a SKILL the same .claude path WOULD be readable by both (Cursor compat).
    expect(readableBy([ap('.claude')], TOOLS, 'skill')).toEqual(['claude-code', 'cursor']);
  });

  it('a .cursor-only agent is readable by Cursor but not Claude', () => {
    expect(readableBy([ap('.cursor')], TOOLS, 'agent')).toEqual(['cursor']);
    expect(followsYouAcross([ap('.cursor')], TOOLS, 'agent')).toBe(false);
  });

  it('an agent in BOTH .claude and .cursor follows you', () => {
    expect(followsYouAcross([ap('.claude'), ap('.cursor')], TOOLS, 'agent')).toBe(true);
  });

  it('Claude also reads .frink/agents (its internal mirror)', () => {
    expect(readableBy([ap('.frink')], TOOLS, 'agent')).toEqual(['claude-code']);
  });
});
