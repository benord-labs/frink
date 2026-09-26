import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { resolvePlanModeChunkSuppression } from './plan-mode-suppression';

// Co-located with the module the predicates moved to (CLAUDE.md: a moved function takes its test
// with it), which also keeps executor.test.ts under its size ratchet.
describe('resolvePlanModeChunkSuppression', () => {
  function makeCtx(over: {
    planCompletedByExitPlanMode: boolean;
    flowPlanAutoApprove: boolean;
    toolNameByCallId?: Map<string, string>;
  }) {
    return {
      planCompletedByExitPlanMode: over.planCompletedByExitPlanMode,
      flowPlanAutoApprove: over.flowPlanAutoApprove,
      suppressNativePlanTools: true,
      suppressPlanText: true,
      toolNameByCallId: over.toolNameByCallId ?? new Map<string, string>(),
      nativePlanStreamCallIds: new Set<string>(),
      suppressedPostPlanToolCallIds: new Set<string>(),
    };
  }
  const toolInput = (toolName: string, toolCallId = 'c1') =>
    ({ type: 'tool-input-available', toolCallId, toolName, input: {} }) as never;
  const textDelta = () => ({ type: 'text-delta', id: 't1', delta: 'hi' }) as never;

  describe('auto-approve, post-ExitPlanMode: streams the in-turn implementation', () => {
    const ctx = () => makeCtx({ planCompletedByExitPlanMode: true, flowPlanAutoApprove: true });

    it('hides only the ExitPlanMode / EnterPlanMode tool rows (the card replaces them)', () => {
      expect(resolvePlanModeChunkSuppression(toolInput('ExitPlanMode'), ctx())).toBe(true);
      expect(resolvePlanModeChunkSuppression(toolInput('EnterPlanMode'), ctx())).toBe(true);
    });

    it('STREAMS implementation Write/Edit/Bash and text (must NOT route through the Write-suppressing path)', () => {
      expect(resolvePlanModeChunkSuppression(toolInput('Write'), ctx())).toBe(false);
      expect(resolvePlanModeChunkSuppression(toolInput('Edit'), ctx())).toBe(false);
      expect(resolvePlanModeChunkSuppression(toolInput('Bash'), ctx())).toBe(false);
      expect(resolvePlanModeChunkSuppression(textDelta(), ctx())).toBe(false);
    });
  });

  describe('non-auto, post-ExitPlanMode: blanket-hide until approval', () => {
    const ctx = () => makeCtx({ planCompletedByExitPlanMode: true, flowPlanAutoApprove: false });

    it('hides every chunk except finish (incl. implementation Write/Bash and text)', () => {
      expect(resolvePlanModeChunkSuppression(toolInput('Write'), ctx())).toBe(true);
      expect(resolvePlanModeChunkSuppression(toolInput('Bash'), ctx())).toBe(true);
      expect(resolvePlanModeChunkSuppression(textDelta(), ctx())).toBe(true);
    });

    it('lets the finish chunk through (trailing sessionId / token metadata)', () => {
      const finish = { type: 'finish', messageMetadata: {} } as never;
      expect(resolvePlanModeChunkSuppression(finish, ctx())).toBe(false);
    });

    it('tracks suppressed post-plan tool-input ids (for synthetic-error suppression downstream)', () => {
      const c = ctx();
      resolvePlanModeChunkSuppression(toolInput('Bash', 'bash-1'), c);
      expect(c.suppressedPostPlanToolCallIds.has('bash-1')).toBe(true);
    });
  });

  describe('plan drafting, pre-ExitPlanMode: dedupe native plan artifacts', () => {
    const ctx = () => makeCtx({ planCompletedByExitPlanMode: false, flowPlanAutoApprove: true });

    it('suppresses the plan-file Write and plan text, but streams research tools (Bash)', () => {
      expect(resolvePlanModeChunkSuppression(toolInput('Write'), ctx())).toBe(true);
      expect(resolvePlanModeChunkSuppression(textDelta(), ctx())).toBe(true);
      expect(resolvePlanModeChunkSuppression(toolInput('Bash'), ctx())).toBe(false);
    });
  });

  it('regression guard: the SAME Write chunk streams under auto-approve but is hidden during drafting', () => {
    const autoApprovePostPlan = makeCtx({
      planCompletedByExitPlanMode: true,
      flowPlanAutoApprove: true,
    });
    const drafting = makeCtx({ planCompletedByExitPlanMode: false, flowPlanAutoApprove: true });
    expect(resolvePlanModeChunkSuppression(toolInput('Write'), autoApprovePostPlan)).toBe(false);
    expect(resolvePlanModeChunkSuppression(toolInput('Write'), drafting)).toBe(true);
  });
});
