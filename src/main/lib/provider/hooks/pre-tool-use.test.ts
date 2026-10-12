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

const UNANSWERED = 'A hook asked to confirm this call, which Frink cannot prompt for yet.';
const defer = pre({ permissionDecision: 'defer', updatedInput: { command: 'deferred' } });
const allow = pre({ permissionDecision: 'allow', updatedInput: { command: 'rewritten' } });

describe('readPreToolUseDispatch', () => {
  it.each([
    ['first', [defer, allow]],
    ['last', [allow, defer]],
  ])('ignores a deferring hook that finished %s; the other hooks still count', (_name, ran) => {
    expect(read(...ran)).toEqual({ updatedInput: { command: 'rewritten' }, common: {} });
  });

  it.each([
    ['check this', `${UNANSWERED} Its reason: check this`],
    [undefined, UNANSWERED],
  ])('refuses a call a hook asks to confirm, with its reason %s', (reason, deny) => {
    const ask = pre({ permissionDecision: 'ask', permissionDecisionReason: reason });
    expect(read(ask, allow)).toMatchObject({ deny });
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

  it('keeps the rewrite of a hook that allows, and approves nothing on its say-so', () => {
    expect(read(allow)).toEqual({ updatedInput: { command: 'rewritten' }, common: {} });
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
