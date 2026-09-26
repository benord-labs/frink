import { describe, expect, it } from 'vitest';
import {
  extractRawTriggerConfig,
  isRuleAutoStartEnabled,
  resolveRuleCompletionSignal,
  resolveRuleStartInWorktree,
  resolveRuleStartMode,
  resolveTaskCompletionSignal,
  resolveTaskExecutionMetadata,
  resolveTaskStartInWorktreeFromConfig,
  resolveTaskStartInWorktreePreference,
  toChatMode,
} from './trigger-rule-config';

describe('shared trigger-rule-config', () => {
  it('resolves start mode from action config with execute default', () => {
    expect(resolveRuleStartMode({ start_mode: 'plan' })).toBe('plan');
    expect(resolveRuleStartMode({ start_mode: 'execute' })).toBe('execute');
    expect(resolveRuleStartMode({ start_mode: 'wait' })).toBe('wait');
    expect(resolveRuleStartMode({ start_mode: 'invalid' })).toBe('execute');
    expect(resolveRuleStartMode({})).toBe('execute');
    expect(resolveRuleStartMode(undefined)).toBe('execute');
  });

  it('maps start mode to auto-start flag', () => {
    expect(isRuleAutoStartEnabled({ start_mode: 'execute' })).toBe(true);
    expect(isRuleAutoStartEnabled({ start_mode: 'plan' })).toBe(false);
    expect(isRuleAutoStartEnabled({ start_mode: 'wait' })).toBe(false);
    expect(isRuleAutoStartEnabled(undefined)).toBe(true);
  });

  it('resolves start_in_worktree with true default', () => {
    expect(resolveRuleStartInWorktree({ start_in_worktree: false })).toBe(false);
    expect(resolveRuleStartInWorktree({ start_in_worktree: true })).toBe(true);
    expect(resolveRuleStartInWorktree({})).toBe(true);
    expect(resolveRuleStartInWorktree(undefined)).toBe(true);
  });

  it('resolves completion_signal with agent_finish default', () => {
    expect(resolveRuleCompletionSignal({ completion_signal: 'manual' })).toBe('manual');
    expect(resolveRuleCompletionSignal({ completion_signal: 'invalid' })).toBe('agent_finish');
    expect(resolveRuleCompletionSignal({})).toBe('agent_finish');
  });

  it('resolves task worktree preference with config override and legacy fallback', () => {
    expect(resolveTaskStartInWorktreePreference(false, 'project-1')).toBe(false);
    expect(resolveTaskStartInWorktreePreference(true, null)).toBe(true);
    expect(resolveTaskStartInWorktreePreference(undefined, 'project-1')).toBe(true);
    expect(resolveTaskStartInWorktreePreference(undefined, null)).toBe(false);
  });

  it('resolves execution metadata from config and trims model', () => {
    expect(
      resolveTaskExecutionMetadata({
        startMode: 'plan',
        model: ' sonnet ',
      }),
    ).toEqual({
      startMode: 'plan',
      skipReview: false,
      configuredModel: 'sonnet',
    });
  });

  it('falls back to execute mode when config is missing or model is empty', () => {
    expect(resolveTaskExecutionMetadata(undefined)).toEqual({
      startMode: 'execute',
      skipReview: true,
    });
    expect(
      resolveTaskExecutionMetadata({
        model: '   ',
      }),
    ).toEqual({
      startMode: 'execute',
      skipReview: true,
    });
    expect(
      resolveTaskExecutionMetadata({
        configured_model: '  ',
      } as unknown as Parameters<typeof resolveTaskExecutionMetadata>[0]),
    ).toEqual({
      startMode: 'execute',
      skipReview: true,
    });
  });

  it('reads configured_model snake_case and prefers camelCase model when both exist', () => {
    expect(
      resolveTaskExecutionMetadata({
        configured_model: ' sonnet ',
      } as unknown as Parameters<typeof resolveTaskExecutionMetadata>[0]),
    ).toEqual({
      startMode: 'execute',
      skipReview: true,
      configuredModel: 'sonnet',
    });

    expect(
      resolveTaskExecutionMetadata({
        model: 'haiku',
        configured_model: 'sonnet',
      } as unknown as Parameters<typeof resolveTaskExecutionMetadata>[0]),
    ).toEqual({
      startMode: 'execute',
      skipReview: true,
      configuredModel: 'haiku',
    });
  });

  it('throws for wait mode when throwOnWait is enabled', () => {
    expect(() =>
      resolveTaskExecutionMetadata(
        {
          startMode: 'wait',
        },
        { throwOnWait: true },
      ),
    ).toThrow('Wait-mode tasks must remain queued and should not be executed');
  });

  it('maps resolved start mode to chats.create mode', () => {
    expect(toChatMode('execute')).toBe('agent');
    expect(toChatMode('plan')).toBe('plan');
    expect(toChatMode('debug')).toBe('debug');
  });

  it('resolves debug start mode (skipReview true — not a plan_ready gate)', () => {
    expect(resolveTaskExecutionMetadata({ startMode: 'debug' })).toEqual({
      startMode: 'debug',
      skipReview: true,
    });
  });

  it('honors an explicit skipReview over the derived default (autoApprove plan)', () => {
    // Plan mode normally pauses (skipReview:false); an explicit skipReview:true (from a flow agent
    // node's autoApprove) auto-advances instead.
    expect(resolveTaskExecutionMetadata({ startMode: 'plan', skipReview: true })).toEqual({
      startMode: 'plan',
      skipReview: true,
    });
    // Explicit skipReview:false on a non-plan mode forces a review pause.
    expect(resolveTaskExecutionMetadata({ startMode: 'execute', skipReview: false })).toEqual({
      startMode: 'execute',
      skipReview: false,
    });
  });

  it('maps overrideMode debug to a debug start mode', () => {
    expect(resolveTaskExecutionMetadata(undefined, { overrideMode: 'debug' })).toEqual({
      startMode: 'debug',
      skipReview: true,
    });
  });

  it('resolves worktree from config', () => {
    expect(
      resolveTaskStartInWorktreeFromConfig(
        {
          startInWorktree: false,
        },
        'project-1',
      ),
    ).toBe(false);
    expect(resolveTaskStartInWorktreeFromConfig(undefined, null)).toBe(false);
    expect(resolveTaskStartInWorktreeFromConfig(undefined, 'project-1')).toBe(true);
  });

  it('resolves task completion signal from config', () => {
    expect(resolveTaskCompletionSignal({ completionSignal: 'manual' })).toBe('manual');
    expect(resolveTaskCompletionSignal({})).toBe('agent_finish');
    expect(
      resolveTaskCompletionSignal({
        completion_signal: 'manual',
      } as unknown as Parameters<typeof resolveTaskCompletionSignal>[0]),
    ).toBe('manual');
  });
});

describe('extractRawTriggerConfig', () => {
  it('extracts _config from a plain object with the field present', () => {
    const config = { startMode: 'plan', model: 'sonnet' };
    const result = extractRawTriggerConfig({ _config: config });
    expect(result).toEqual(config);
  });

  it('returns undefined when _config is absent', () => {
    expect(extractRawTriggerConfig({ source: 'shortcut' })).toBeUndefined();
    expect(extractRawTriggerConfig({})).toBeUndefined();
  });

  it('returns undefined when _config is not an object', () => {
    expect(extractRawTriggerConfig({ _config: 'string' })).toBeUndefined();
    expect(extractRawTriggerConfig({ _config: 42 })).toBeUndefined();
    expect(extractRawTriggerConfig({ _config: null })).toBeUndefined();
    expect(extractRawTriggerConfig({ _config: [] })).toBeUndefined();
  });

  it('returns undefined for null and undefined inputs', () => {
    expect(extractRawTriggerConfig(null)).toBeUndefined();
    expect(extractRawTriggerConfig(undefined)).toBeUndefined();
  });
});
