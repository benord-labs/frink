import { describe, expect, it, vi } from 'vitest';
import { createSubagentAllowlistHook, type SubagentHookInput } from './subagent-allowlist-hook';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

// The provider runs the REAL allowlist matcher on an enforce-mode (Claude) gate, so the tests below
// judge exactly what a live session would.
vi.mock('../provider', async () => {
  const { enforceAllowlist } = await import('../provider/handlers/allowlist');
  return {
    project: vi.fn((projectId: string, projectPath: string) => ({
      enforce: (_category: string, rule?: unknown) =>
        enforceAllowlist({
          mode: 'enforce',
          rule,
          ctx: { projectId, projectPath, provider: 'claude-code' },
        }),
    })),
  };
});

const askInput = (extra: Partial<SubagentHookInput> = {}): SubagentHookInput => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {},
  agent_id: 'agent-1',
  agent_type: 'code-reviewer',
  ...extra,
});

const makeHook = (markDenied = vi.fn()) => ({
  markDenied,
  hook: createSubagentAllowlistHook({
    agents: {},
    project: { id: 'proj-1' },
    projectPath: '/repo',
    markDenied,
  }),
});

/**
 * The hook returns a bare `{}` to let a call through, and `{}` absorbs every other member of the
 * union — so `in` cannot narrow it. Read the field off a declared shape instead; `undefined` is
 * exactly the let-through case.
 */
type HookResult = Awaited<ReturnType<ReturnType<typeof createSubagentAllowlistHook>>>;
type Denial = { permissionDecision: string; permissionDecisionReason: string };
const denial = (result: HookResult): Denial | undefined =>
  (result as { hookSpecificOutput?: Denial }).hookSpecificOutput;

describe('createSubagentAllowlistHook — asking the user', () => {
  // Only the agent that owns the turn can reach the user: a sub-agent's question would hold its
  // PARENT's turn open, and expire it on something the parent has already moved past.
  it('refuses a sub-agent AskUserQuestion and records the reason against the call', async () => {
    const { hook, markDenied } = makeHook();

    const result = denial(await hook(askInput(), 'tu-1'));

    expect(result?.permissionDecision).toBe('deny');
    expect(result?.permissionDecisionReason).toContain('unavailable to sub-agents');
    // PreToolUse is the only seam whose reason survives to the model, so it must carry one.
    expect(markDenied).toHaveBeenCalledWith('tu-1', expect.stringContaining('report the choice'));
  });

  // The refusal used to be gated on the turn being flow-driven. The hold now applies to every turn,
  // so a sub-agent ask is just as damaging in a plain chat.
  it('refuses on a plain chat turn too, not only a flow-driven one', async () => {
    const { hook } = makeHook();

    expect(denial(await hook(askInput(), 'tu-2'))?.permissionDecision).toBe('deny');
  });

  // `agent_id` is present only when a native sub-agent fires the tool, so its absence IS the main
  // thread — which must keep its question.
  it('leaves the main agent alone, since only a sub-agent call carries attribution', async () => {
    const { hook, markDenied } = makeHook();

    expect(await hook(askInput({ agent_id: undefined }), 'tu-3')).toEqual({});
    expect(await hook(askInput({ agent_type: undefined }), 'tu-4')).toEqual({});
    expect(markDenied).not.toHaveBeenCalled();
  });

  // The refusal is deliberately ordered ahead of the `project` guard: that one gates allowlist
  // lookup, and who may reach the user does not depend on it.
  it('refuses even with no project resolved', async () => {
    const markDenied = vi.fn();
    const hook = createSubagentAllowlistHook({
      agents: {},
      project: null,
      projectPath: '/repo',
      markDenied,
    });

    expect(denial(await hook(askInput(), 'tu-5'))?.permissionDecision).toBe('deny');
  });
});

describe('createSubagentAllowlistHook — pinned tool allowlist', () => {
  const reviewerInput = (toolName: string): SubagentHookInput => ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    agent_id: 'agent-7',
    agent_type: 'correctness-reviewer',
  });

  const makeReviewerHook = (markDenied = vi.fn()) => ({
    markDenied,
    hook: createSubagentAllowlistHook({
      agents: { 'correctness-reviewer': { tools: ['Read', 'Grep', 'Glob', 'Bash'] } },
      project: { id: 'proj-1' },
      projectPath: '/repo',
      markDenied,
    }),
  });

  // sc-3852: the CLI grants SubagentHandback whatever the agent's list says; denying it here lost
  // the finished report, and the parent saw only "ended without delivering a report".
  it("lets a pinned reviewer hand its report back even though it is not on the agent's list", async () => {
    const { hook, markDenied } = makeReviewerHook();

    expect(await hook(reviewerInput('SubagentHandback'), 'tu-10')).toEqual({});
    expect(markDenied).not.toHaveBeenCalled();
  });

  it('refuses an MCP tool merely named like the hand-back', async () => {
    const { hook } = makeReviewerHook();

    const result = denial(await hook(reviewerInput('mcp__evil__SubagentHandback'), 'tu-12'));

    expect(result?.permissionDecision).toBe('deny');
  });

  // `tools: []` is truthy, so the hook still enforces — the hand-back must survive that boundary.
  it('lets an agent pinned to an empty tool list hand its report back', async () => {
    const markDenied = vi.fn();
    const hook = createSubagentAllowlistHook({
      agents: { 'correctness-reviewer': { tools: [] } },
      project: { id: 'proj-1' },
      projectPath: '/repo',
      markDenied,
    });

    expect(await hook(reviewerInput('SubagentHandback'), 'tu-13')).toEqual({});
    expect(denial(await hook(reviewerInput('Read'), 'tu-14'))?.permissionDecision).toBe('deny');
    expect(markDenied).toHaveBeenCalledTimes(1);
  });

  it('still refuses an off-list tool for the same agent', async () => {
    const { hook, markDenied } = makeReviewerHook();

    const result = denial(await hook(reviewerInput('Write'), 'tu-11'));

    expect(result?.permissionDecision).toBe('deny');
    expect(result?.permissionDecisionReason).toContain('Write is not on its allowlist');
    expect(markDenied).toHaveBeenCalledWith(
      'tu-11',
      expect.stringContaining('correctness-reviewer'),
    );
  });
});
