import type { PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { HookRegistration } from '../../../../shared/types/hook-inventory';
import { combineHookReadings } from './dispatch';
import { readPreToolUseDispatch } from './pre-tool-use';
import type { HookReading } from './read-output';

const registration: HookRegistration = {
  id: 'project:PreToolUse:0:check',
  scope: 'project',
  file: '/work/.claude/settings.json',
  event: 'PreToolUse',
  handlerType: 'command',
  label: 'check',
  command: 'check',
  binding: { status: 'supported', ignored: [] },
};

/** What the gate makes of these readings, given in the order the hooks finished. */
function read(...readings: HookReading[]) {
  const ran = readings.map((reading) => ({ hook: registration, command: 'check', reading }));
  return readPreToolUseDispatch('Bash', combineHookReadings('PreToolUse', ran));
}

function pre(fields: Omit<PreToolUseHookSpecificOutput, 'hookEventName'>): HookReading {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } };
}

const defer = pre({ permissionDecision: 'defer', updatedInput: { command: 'deferred' } });
const allow = pre({ permissionDecision: 'allow', updatedInput: { command: 'rewritten' } });

describe('readPreToolUseDispatch', () => {
  it.each([
    ['first', [defer, allow]],
    ['last', [allow, defer]],
  ])('ignores a deferring hook that finished %s; the other hooks still count', (_name, ran) => {
    expect(read(...ran)).toEqual({
      permission: { decision: 'allow' },
      updatedInput: { command: 'rewritten' },
      common: {},
    });
  });

  it('hands the gate an ask with its reason, outranking an allow, and denies nothing', () => {
    const ask = pre({ permissionDecision: 'ask', permissionDecisionReason: 'check this' });
    expect(read(allow, ask)).toEqual({
      permission: { decision: 'ask', reason: 'check this' },
      updatedInput: { command: 'rewritten' },
      common: {},
    });
  });

  it('drops the decision when a hook stops the turn, since continue: false outranks it', () => {
    const stopping = { ...pre({ permissionDecision: 'ask' }), continue: false };
    expect(read(allow, stopping)).toEqual({
      updatedInput: { command: 'rewritten' },
      common: { continue: false, stopReason: undefined },
    });
  });

  it("joins every block reason, a deferring hook's included, and ignores a deferring hook's stop", () => {
    const stops = { ...defer, continue: false, systemMessage: 'from the deferring hook' };
    const result = read(
      stops,
      { ...defer, block: { reason: 'one' } },
      { block: { reason: 'two' } },
    );
    expect(result).toEqual({ deny: 'one\ntwo', common: {} });
  });

  it('hands the gate an allow with its rewrite, leaving the rules to judge it', () => {
    expect(read(allow)).toEqual({
      permission: { decision: 'allow' },
      updatedInput: { command: 'rewritten' },
      common: {},
    });
  });

  it('joins the context of several hooks, and their warnings with the hook error notices', () => {
    const result = read(
      { ...pre({ additionalContext: 'first' }), systemMessage: 'careful' },
      pre({ additionalContext: 'second' }),
      { error: 'Timed out; its output was discarded' },
    );
    expect(result.additionalContext).toBe('first\nsecond');
    expect(result.common).toEqual({
      systemMessage: 'careful\nPreToolUse:Bash hook error: Timed out; its output was discarded',
    });
  });
});
