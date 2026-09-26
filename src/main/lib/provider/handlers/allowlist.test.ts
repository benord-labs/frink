import { describe, expect, it, vi } from 'vitest';
import { enforceAllowlist, isToolAllowedForAgent } from './allowlist';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

const ctx = { projectId: 'p', projectPath: '/p', provider: 'claude-code' as const };

describe('isToolAllowedForAgent (PCH-5 pure matcher)', () => {
  it('allows listed tools and denies off-list tools when `tools` is declared', () => {
    const r = { tools: ['Read', 'Grep'] };
    expect(isToolAllowedForAgent('Read', r)).toBe(true);
    expect(isToolAllowedForAgent('Grep', r)).toBe(true);
    expect(isToolAllowedForAgent('Bash', r)).toBe(false);
    expect(isToolAllowedForAgent('Edit', r)).toBe(false);
  });

  it('REQUIRED tools always pass the tools-membership check (broken-agent prevention)', () => {
    const r = { tools: ['Read', 'Grep'] };
    for (const t of ['TodoWrite', 'ExitPlanMode', 'Task', 'Agent']) {
      expect(isToolAllowedForAgent(t, r)).toBe(true);
    }
  });

  it('denies disallowedTools entries (and disallowed wins over a tools listing)', () => {
    expect(isToolAllowedForAgent('Edit', { disallowedTools: ['Edit'] })).toBe(false);
    expect(
      isToolAllowedForAgent('Edit', { tools: ['Read', 'Edit'], disallowedTools: ['Edit'] }),
    ).toBe(false);
  });

  it('never denies a REQUIRED tool, even via an explicit disallowedTools entry', () => {
    // Mirrors the rule-validator, which refuses user deny-rules on these.
    expect(isToolAllowedForAgent('TodoWrite', { disallowedTools: ['TodoWrite'] })).toBe(true);
  });

  it('allows everything for an unrestricted agent', () => {
    expect(isToolAllowedForAgent('Bash', {})).toBe(true);
    expect(isToolAllowedForAgent('mcp__github__create_pr', {})).toBe(true);
  });

  it('matches mcp__* names exactly like any other tool name', () => {
    const r = { tools: ['Read', 'mcp__github__get_issue'] };
    expect(isToolAllowedForAgent('mcp__github__get_issue', r)).toBe(true);
    expect(isToolAllowedForAgent('mcp__github__create_pr', r)).toBe(false);
  });
});

describe('enforceAllowlist (PCH-5 handler)', () => {
  it('returns denied with an honest detail on an enforce-mode miss', async () => {
    const res = await enforceAllowlist({
      mode: 'enforce',
      rule: { toolName: 'Bash', agentType: 'auditor', restrictions: { tools: ['Read', 'Grep'] } },
      ctx,
    });
    expect(res.status).toBe('denied');
    expect(res.detail).toContain("Agent 'auditor'");
    expect(res.detail).toContain('Bash');
  });

  it('returns enforced when the call is on the allowlist', async () => {
    const res = await enforceAllowlist({
      mode: 'enforce',
      rule: { toolName: 'Read', agentType: 'auditor', restrictions: { tools: ['Read'] } },
      ctx,
    });
    expect(res.status).toBe('enforced');
  });

  it('advisory mode never denies', async () => {
    const res = await enforceAllowlist({
      mode: 'advisory',
      rule: { toolName: 'Bash', agentType: 'auditor', restrictions: { tools: ['Read'] } },
      ctx: { ...ctx, provider: 'cursor' as const },
    });
    expect(res.status).toBe('noop');
  });
});
