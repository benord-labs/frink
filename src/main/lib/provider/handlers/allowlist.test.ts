import log from 'electron-log';
import { describe, expect, it, vi } from 'vitest';
import { enforceAllowlist, isToolAllowedForAgent, isUnknownBuiltinTool } from './allowlist';

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
    for (const t of ['TodoWrite', 'ExitPlanMode', 'Task', 'Agent', 'SubagentHandback']) {
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

  // sc-3852: the CLI delivers every sub-agent's final report through SubagentHandback. Denying it
  // to a pinned reviewer silently drops the finished report on the floor.
  it('lets a pinned reviewer hand its report back, without widening the rest of its allowlist', () => {
    const reviewer = { tools: ['Read', 'Grep', 'Glob', 'Bash'] };
    expect(isToolAllowedForAgent('SubagentHandback', reviewer)).toBe(true);
    expect(
      isToolAllowedForAgent('SubagentHandback', {
        ...reviewer,
        disallowedTools: ['SubagentHandback'],
      }),
    ).toBe(true);
    expect(isToolAllowedForAgent('Write', reviewer)).toBe(false);
  });

  // The exemption is an exact name: a lookalike must not ride it past a pinned allowlist.
  it('exempts only the exact SubagentHandback name, not lookalikes', () => {
    const reviewer = { tools: ['Read', 'Grep'] };
    for (const t of ['mcp__evil__SubagentHandback', 'subagenthandback', 'SubagentHandback ']) {
      expect(isToolAllowedForAgent(t, reviewer)).toBe(false);
    }
  });

  it('lets an agent pinned to no tools at all still hand its report back', () => {
    const reportOnly = { tools: [] };
    expect(isToolAllowedForAgent('SubagentHandback', reportOnly)).toBe(true);
    expect(isToolAllowedForAgent('Read', reportOnly)).toBe(false);
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

// The CLI reads `mcp__srv__*` and bare `mcp__srv` as every tool on server `srv` (probed on SDK
// 0.3.278); reviewer agents ship lists like these, so an exact-only match denied their MCP tools.
describe('isToolAllowedForAgent — MCP server entries', () => {
  const reviewer = { tools: ['Read', 'mcp__codebase__*', 'mcp__autonomous_bugs'] };

  it('grants every tool on a server named by `mcp__srv__*` or bare `mcp__srv`', () => {
    expect(isToolAllowedForAgent('mcp__codebase__searchCode', reviewer)).toBe(true);
    expect(isToolAllowedForAgent('mcp__autonomous_bugs__search_autonomous_issues', reviewer)).toBe(
      true,
    );
  });

  it('does not reach a different server, including one whose name merely starts the same', () => {
    expect(isToolAllowedForAgent('mcp__github__create_pr', reviewer)).toBe(false);
    expect(isToolAllowedForAgent('mcp__codebase2__searchCode', reviewer)).toBe(false);
    expect(isToolAllowedForAgent('mcp__autonomous_bugs_admin__wipe', reviewer)).toBe(false);
  });

  it('does not read a lone `mcp__*` as a grant of every MCP tool', () => {
    expect(isToolAllowedForAgent('mcp__github__create_pr', { tools: ['mcp__*'] })).toBe(false);
  });

  it('applies a server entry in disallowedTools too, over a listing in tools', () => {
    const r = { tools: ['mcp__github__create_pr'], disallowedTools: ['mcp__github__*'] };
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

  it('enforces (does not deny) a pinned reviewer handing its report back', async () => {
    const res = await enforceAllowlist({
      mode: 'enforce',
      rule: {
        toolName: 'SubagentHandback',
        agentType: 'correctness-reviewer',
        restrictions: { tools: ['Read', 'Grep', 'Glob', 'Bash'] },
      },
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

// A newer CLI can grant sub-agents plumbing this list has never heard of (as with SubagentHandback).
// On Claude the SDK filtered first, so an unknown built-in passes and is named once in the log.
describe('enforceAllowlist — built-in tools Frink does not know yet', () => {
  const reviewer = { tools: ['Read', 'Grep'] };
  const call = (toolName: string, provider: 'claude-code' | 'codex' = 'claude-code') =>
    enforceAllowlist({
      mode: 'enforce',
      rule: { toolName, agentType: 'correctness-reviewer', restrictions: reviewer },
      ctx: { ...ctx, provider },
    });

  it('classifies only non-MCP names outside KNOWN_TOOLS and REQUIRED_TOOLS as unknown', () => {
    expect(isUnknownBuiltinTool('SomeFutureCliTool')).toBe(true);
    expect(isUnknownBuiltinTool('Write')).toBe(false);
    expect(isUnknownBuiltinTool('SubagentHandback')).toBe(false);
    expect(isUnknownBuiltinTool('mcp__github__create_pr')).toBe(false);
  });

  it('passes an unknown built-in on Claude and warns about it only once', async () => {
    vi.mocked(log.warn).mockClear();

    expect((await call('FutureInfraToolA')).status).toBe('enforced');
    expect((await call('FutureInfraToolA')).status).toBe('enforced');

    const warnings = vi
      .mocked(log.warn)
      .mock.calls.filter(([m]) => String(m).includes('FutureInfraToolA'));
    expect(warnings).toHaveLength(1);
  });

  it('still denies a known built-in and an unlisted MCP tool', async () => {
    expect((await call('Write')).status).toBe('denied');
    expect((await call('mcp__github__create_pr')).status).toBe('denied');
  });

  // The pass covers a tool merely absent from `tools`; one the author forbade by name stays denied.
  it('still denies an unknown built-in the agent explicitly disallows', async () => {
    const disallow = (restrictions: { tools?: string[]; disallowedTools: string[] }) =>
      enforceAllowlist({
        mode: 'enforce',
        rule: { toolName: 'FutureInfraToolC', agentType: 'correctness-reviewer', restrictions },
        ctx,
      });

    expect((await disallow({ disallowedTools: ['FutureInfraToolC'] })).status).toBe('denied');
    expect(
      (await disallow({ tools: ['Read'], disallowedTools: ['FutureInfraToolC'] })).status,
    ).toBe('denied');
  });

  it('stays strict for an unknown built-in on a provider the SDK does not filter for', async () => {
    expect((await call('FutureInfraToolB', 'codex')).status).toBe('denied');
  });
});
