import { describe, expect, it } from 'vitest';
import { extractRawTriggerConfig } from '../../../../shared/lib/trigger-rule-config';
import {
  deriveTaskClaimFlags,
  getFlowConfigField,
  isDeliberateRedispatch,
  isRecord,
  isString,
  resolveClaimResume,
  taskClaimResultSchema,
} from './claim-flags';

describe('taskClaimResultSchema', () => {
  it('keeps valid claim fields when optional siblings are malformed', () => {
    const result = taskClaimResultSchema.parse({
      chatId: 'chat-123',
      subChatId: 42,
      retryMode: 'restart',
      retryPriorError: false,
    });

    expect(result.chatId).toBe('chat-123');
    expect(result.retryMode).toBe('restart');
    expect(result.subChatId).toBeUndefined();
    expect(result.retryPriorError).toBeUndefined();
  });
});

describe('isString', () => {
  it('is true only for string primitives', () => {
    expect(isString('')).toBe(true);
    expect(isString('x')).toBe(true);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString(0)).toBe(false);
    expect(isString(String('x'))).toBe(true);
  });
});

describe('isRecord', () => {
  it('is false for null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(1)).toBe(false);
  });

  it('is true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
});

describe('getFlowConfigField', () => {
  it('returns null when rawConfig is undefined', () => {
    expect(getFlowConfigField(undefined, 'k', isString)).toBeNull();
  });

  it('returns null when rawConfig is null or not a plain object', () => {
    expect(getFlowConfigField(null, 'k', isString)).toBeNull();
    expect(getFlowConfigField('x', 'k', isString)).toBeNull();
    expect(getFlowConfigField(1, 'k', isString)).toBeNull();
    expect(getFlowConfigField([], 'k', isString)).toBeNull();
  });

  it('returns null when key is missing or guard rejects', () => {
    expect(getFlowConfigField({}, 'missing', isString)).toBeNull();
    expect(getFlowConfigField({ a: 1 }, 'a', isString)).toBeNull();
  });

  it('returns the value when guard passes', () => {
    expect(getFlowConfigField({ a: 'ok' }, 'a', isString)).toBe('ok');
  });

  it('returns empty string when value is empty string and guard is isString', () => {
    expect(getFlowConfigField({ chat: '' }, 'chat', isString)).toBe('');
  });
});

// Drives the renderer's alreadySent-dedup bypass for deliberate flow re-dispatches: only the
// literal `isNodeRedispatch: true` stamped by dispatchAgent counts — anything looser would widen
// the bypass to tasks whose prompt must NOT be re-sent.
describe('isDeliberateRedispatch', () => {
  it('true only for the literal flag', () => {
    expect(isDeliberateRedispatch({ isNodeRedispatch: true })).toBe(true);
  });

  it('false when the flag is absent', () => {
    expect(isDeliberateRedispatch({})).toBe(false);
    expect(isDeliberateRedispatch(undefined)).toBe(false);
    expect(isDeliberateRedispatch(null)).toBe(false);
  });

  it('false for non-true values (no truthy coercion)', () => {
    expect(isDeliberateRedispatch({ isNodeRedispatch: false })).toBe(false);
    expect(isDeliberateRedispatch({ isNodeRedispatch: 'true' })).toBe(false);
    expect(isDeliberateRedispatch({ isNodeRedispatch: 1 })).toBe(false);
  });
});

// The split is load-bearing: isRetry (renderer dedup bypass) widens to re-dispatches, but
// isUserRetryClaim (the unpark gate) must NEVER — a re-dispatch runs with its flow already
// `running`, so unparking would refuse and fail the fresh task. Merging these back breaks
// every deliberate re-dispatch.
describe('deriveTaskClaimFlags', () => {
  it('plain first dispatch → neither flag', () => {
    expect(deriveTaskClaimFlags(null, {})).toEqual({ isRetry: false, isUserRetryClaim: false });
  });

  it('deliberate re-dispatch → dedup bypass WITHOUT the unpark claim', () => {
    expect(deriveTaskClaimFlags(null, { isNodeRedispatch: true })).toEqual({
      isRetry: true,
      isUserRetryClaim: false,
    });
  });

  it('tasks.retry claim → both flags', () => {
    expect(deriveTaskClaimFlags('continue', {})).toEqual({
      isRetry: true,
      isUserRetryClaim: true,
    });
    expect(deriveTaskClaimFlags('restart', { isNodeRedispatch: true })).toEqual({
      isRetry: true,
      isUserRetryClaim: true,
    });
  });

  it('a continuation terminal-resume dispatch NEVER claims the unpark — its run is already running, so isUserRetryClaim would force-fail the task', () => {
    expect(deriveTaskClaimFlags(null, { resumeSession: true, isNodeRedispatch: true })).toEqual({
      isRetry: true,
      isUserRetryClaim: false,
    });
  });
});

describe('resolveClaimResume', () => {
  const PINNED = { resumeSession: true, resumeSubChatId: 'sub-1' };

  it('tasks.retry continue claim → continues with its own prior error (no pin needed — the row carries its sub-chat)', () => {
    expect(resolveClaimResume('continue', 'prior boom', {}, null)).toEqual({
      continueSession: true,
      priorError: 'prior boom',
    });
  });

  it('continuation terminal-resume → continues when the claim resolved the pinned sub-chat', () => {
    expect(
      resolveClaimResume(null, null, { ...PINNED, resumePriorError: 'flow boom' }, 'sub-1'),
    ).toEqual({ continueSession: true, priorError: 'flow boom' });
  });

  it('claim landed on a DIFFERENT sub-chat than the mint-time gate validated → full prompt, no nudge', () => {
    expect(resolveClaimResume(null, null, PINNED, 'sub-2').continueSession).toBe(false);
    // Legacy/absent pin never continues either — the pin is required, not optional.
    expect(resolveClaimResume(null, null, { resumeSession: true }, 'sub-1').continueSession).toBe(
      false,
    );
  });

  it('result retryPriorError wins over the config one', () => {
    expect(
      resolveClaimResume('continue', 'result boom', { resumePriorError: 'config boom' }, 'sub-1'),
    ).toEqual({ continueSession: true, priorError: 'result boom' });
  });

  it('restart / plain claims → no continuation', () => {
    expect(resolveClaimResume('restart', null, {}, 'sub-1')).toEqual({
      continueSession: false,
      priorError: null,
    });
    expect(resolveClaimResume(null, null, { isNodeRedispatch: true }, 'sub-1')).toEqual({
      continueSession: false,
      priorError: null,
    });
  });

  it('non-true resumeSession values never continue', () => {
    expect(
      resolveClaimResume(null, null, { resumeSession: 'yes', resumeSubChatId: 'sub-1' }, 'sub-1')
        .continueSession,
    ).toBe(false);
    expect(
      resolveClaimResume(null, null, { resumeSession: 1, resumeSubChatId: 'sub-1' }, 'sub-1')
        .continueSession,
    ).toBe(false);
  });
});

// Cross-module wiring: dispatchAgent stamps the flag at triggerContext._config; the executor
// reads it via extractRawTriggerConfig. Drift in either location silently reverts the dedup
// fix while every unit test stays green — so pin the read against the writer's real shape.
describe('isDeliberateRedispatch × extractRawTriggerConfig wiring', () => {
  // Mirrors the triggerContext dispatchAgent builds for a re-dispatched agent node.
  const AGENT_TASK_TRIGGER_CONTEXT = {
    _config: {
      blockType: 'agent',
      executionMode: 'continue_chat',
      continueChatId: 'chat-1',
      showTriggerCard: false,
      isNodeRedispatch: true,
    },
    _flowOriginId: 'run-1',
    _flowChainDepth: 1,
    chatId: 'chat-1',
    subChatId: 'sub-1',
  };

  it('reads the flag from a dispatchAgent-shaped trigger context', () => {
    expect(isDeliberateRedispatch(extractRawTriggerConfig(AGENT_TASK_TRIGGER_CONTEXT))).toBe(true);
  });

  it('a flag at the context ROOT (wrong location) does not count', () => {
    expect(isDeliberateRedispatch(extractRawTriggerConfig({ isNodeRedispatch: true }))).toBe(false);
  });
});
