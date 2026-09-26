import { describe, expect, it, vi } from 'vitest';
import { createSubagentAllowlistHook, type SubagentHookInput } from './subagent-allowlist-hook';

// The AskUserQuestion refusal returns before any allowlist lookup, so the provider is never
// reached on these paths — mocked only so the module graph loads.
vi.mock('../provider', () => ({ project: vi.fn() }));

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
