import { describe, expect, it } from 'vitest';
import { TRIGGER_BUBBLE_MARKER } from '../../../shared/lib/trigger-bubble-marker';
import type { Task as DbTask } from '../db/schema';
import {
  assertReuseWorktreeHasPath,
  buildInitialTaskChatName,
  isStartTaskFallbackMode,
  resolveTaskExecutionOptions,
  resolveTaskStartInWorktree,
  shouldForwardTaskModel,
} from './index';
import { buildRetryContinuationPrompt, buildTaskPrompt } from './task-prompt';
import { toTaskAccountType } from './execution-account';

const WAIT_MODE_ERROR_REGEX = /must remain queued/i;

describe('assertReuseWorktreeHasPath', () => {
  it('throws when reuseWorktree is true but worktreePath is null', () => {
    expect(() => assertReuseWorktreeHasPath(true, null)).toThrow(
      /reuseWorktree requested but no worktreePath provided/,
    );
  });

  it('throws when reuseWorktree is true but worktreePath is empty string', () => {
    expect(() => assertReuseWorktreeHasPath(true, '')).toThrow(
      /reuseWorktree requested but no worktreePath provided/,
    );
  });

  it('does not throw when reuseWorktree is false with null path', () => {
    expect(() => assertReuseWorktreeHasPath(false, null)).not.toThrow();
  });

  it('does not throw when reuseWorktree is true with a non-empty path', () => {
    expect(() => assertReuseWorktreeHasPath(true, '/tmp/wt')).not.toThrow();
  });
});

describe('shouldForwardTaskModel', () => {
  // Each account forwards ONLY its own picker namespace; the renderer transport (claude) or the
  // executor's resolveCodexCliModel (codex) converts picker -> CLI downstream. Versioned picker ids
  // (`.`/effort/context suffixes) must forward. A raw CLI/Anthropic id (`claude-opus-4-8`) is malformed
  // storage and must be rejected (else getClaudeCliModel silently resolves it to sonnet).
  it.each([
    ['sonnet', 'claude-code', true],
    ['haiku', 'claude-code', true],
    ['opus-4.8', 'claude-code', true],
    ['opus-4.7-max', 'claude-code', true],
    ['cursor-auto', 'claude-code', false],
    ['codex-gpt-5.3-codex-high', 'codex', true],
    ['codex-gpt-5.1-codex-max-xhigh', 'codex', true],
    ['sonnet', 'codex', false],
    ['codex-gpt-5.3-codex-high', 'claude-code', false],
    [undefined, 'claude-code', false],
    ['unknown-model', 'claude-code', false],
    ['claude-opus-4-8', 'claude-code', false],
  ] as const)('forward(%s, %s) === %s', (model, account, expected) => {
    expect(shouldForwardTaskModel(model, account)).toBe(expected);
  });
});

describe('toTaskAccountType', () => {
  // Regression guard: a codex credential must map to a codex account, NOT collapse to claude-code
  // (which would drop the codex model in flows). NULL/legacy/unknown types fall back to claude-code.
  it.each([
    ['codex', 'codex'],
    ['claude-code', 'claude-code'],
    ['', 'claude-code'],
    ['something-new', 'claude-code'],
  ] as const)('toTaskAccountType(%s) === %s', (credType, expected) => {
    expect(toTaskAccountType(credType)).toBe(expected);
  });
});

describe('resolveTaskExecutionOptions', () => {
  const baseTask = {
    id: 'task-1',
    projectId: null,
    title: null,
    description: 'Task description',
    source: 'shortcut',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: false,
    status: 'pending',
    result: null,
    triggerContext: null,
    flowRunId: null,
    nodeRunId: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    executedBy: null,
  } satisfies DbTask;

  it('defaults to execute mode and no skipReview without trigger context', () => {
    expect(resolveTaskExecutionOptions(baseTask)).toEqual({
      startMode: 'execute',
      skipReview: false,
    });
  });

  it('uses trigger context config when available', () => {
    const taskWithConfig: DbTask = {
      ...baseTask,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'Rule',
        eventType: 'story_assigned',
        triggeredBy: {},
        timestamp: new Date().toISOString(),
        fullContent: {},
        autoStart: true,
        _config: {
          startMode: 'plan',
          model: 'sonnet',
        },
      },
    };
    expect(resolveTaskExecutionOptions(taskWithConfig)).toEqual({
      startMode: 'plan',
      skipReview: false,
      configuredModel: 'sonnet',
    });
  });

  it('reads _config from non-webhook trigger_context that lacks full TriggerContext fields', () => {
    // Flow-dispatch tasks (manual, schedule, post_task) store a minimal trigger_context
    // that does NOT satisfy the full TriggerContext shape. extractRawTriggerConfig must
    // still surface the _config so settings apply.
    const taskWithFlowContext: DbTask = {
      ...baseTask,
      triggerContext: {
        _config: { startMode: 'plan', model: 'sonnet' },
      },
    };

    expect(resolveTaskExecutionOptions(taskWithFlowContext)).toEqual({
      startMode: 'plan',
      skipReview: false,
      configuredModel: 'sonnet',
    });
  });

  it('prefers result.startMode over triggerContext._config.startMode', () => {
    // result.startMode is the task's CURRENT mode; a re-claim must honour it over the node's
    // original config rather than reverting the task to its dispatch-time mode.
    const resumedTask: DbTask = {
      ...baseTask,
      result: { startMode: 'execute' },
      triggerContext: {
        _config: { startMode: 'plan' },
      },
    };

    expect(resolveTaskExecutionOptions(resumedTask).startMode).toBe('execute');
  });

  it('falls back to trigger config when result has no valid startMode', () => {
    const taskWithJunkResult: DbTask = {
      ...baseTask,
      result: { startMode: 'wait', chatId: 'c1' },
      triggerContext: {
        _config: { startMode: 'plan' },
      },
    };

    expect(resolveTaskExecutionOptions(taskWithJunkResult).startMode).toBe('plan');
  });

  it('throws when wait-mode task reaches executor', () => {
    const taskWithWaitMode: DbTask = {
      ...baseTask,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'Rule',
        eventType: 'story_assigned',
        triggeredBy: {},
        timestamp: new Date().toISOString(),
        fullContent: {},
        autoStart: false,
        _config: {
          startMode: 'wait',
          model: 'sonnet',
        },
      },
    };

    expect(() => resolveTaskExecutionOptions(taskWithWaitMode)).toThrow(WAIT_MODE_ERROR_REGEX);
  });

  it('runs a wait-mode task that was explicitly started with a mode', () => {
    const started: DbTask = {
      ...baseTask,
      result: { startMode: 'execute' },
      triggerContext: { _config: { startMode: 'wait', model: 'sonnet' } },
    };

    expect(resolveTaskExecutionOptions(started)).toEqual({
      startMode: 'execute',
      skipReview: true,
      configuredModel: 'sonnet',
    });
  });
});

// Blast radius of relaxing isValidTriggerContext: flow-webhook tasks (no legacy rule fields)
// now parse to a non-null TriggerContext, so they flow through buildTaskPrompt + the exec-option
// resolvers. Assert the bubble is sane (no empty-rule artifact) and exec-options are unchanged
// (the _config is identical whether read via the parsed context or extractRawTriggerConfig).
describe('webhook flow task — relaxed trigger-context validator', () => {
  const webhookTask = {
    id: 'task-wh',
    projectId: null,
    title: null,
    description: 'Do the thing',
    source: 'shortcut',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: false,
    status: 'pending',
    result: null,
    // No sourceAccountName / triggerRuleId / triggerRuleName — exactly buildWebhookTriggerContext.
    triggerContext: {
      source: 'shortcut',
      sourceAccountId: 'integration-uuid',
      eventType: 'story_update',
      triggeredBy: { externalUserId: 'm1' },
      timestamp: '2026-06-01T12:00:00.000Z',
      fullContent: { primary_id: 4821, actions: [{ name: 'A story', entity_type: 'story' }] },
      _config: { startMode: 'plan', model: 'sonnet' },
    },
    flowRunId: 'flow-1',
    nodeRunId: 'node-1',
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    executedBy: null,
  } satisfies DbTask;

  it('resolveTaskExecutionOptions reads _config (same as the pre-relax extractRawTriggerConfig path)', () => {
    expect(resolveTaskExecutionOptions(webhookTask)).toEqual({
      startMode: 'plan',
      skipReview: false,
      configuredModel: 'sonnet',
    });
  });

  it('buildTaskPrompt injects a sane TriggerBubble with no empty-rule / undefined artifact', () => {
    const prompt = buildTaskPrompt(webhookTask);
    expect(prompt).toContain(TRIGGER_BUBBLE_MARKER);
    expect(prompt).not.toContain('Trigger rule:');
    expect(prompt).not.toContain('undefined');
  });

  it('buildTaskPrompt omits the bubble when the flow set showTriggerCard:false', () => {
    const prompt = buildTaskPrompt({
      ...webhookTask,
      triggerContext: { ...webhookTask.triggerContext, _config: { showTriggerCard: false } },
    });
    expect(prompt).not.toContain(TRIGGER_BUBBLE_MARKER);
  });
});

describe('resolveTaskStartInWorktree', () => {
  const baseTask = {
    id: 'task-1',
    projectId: null,
    title: null,
    description: 'Task description',
    source: 'shortcut',
    sourceId: null,
    executionTarget: 'local',
    requiresFilesystem: false,
    status: 'pending',
    result: null,
    triggerContext: null,
    flowRunId: null,
    nodeRunId: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    executedBy: null,
  } satisfies DbTask;

  it('uses configured startInWorktree when present', () => {
    const taskWithConfig: DbTask = {
      ...baseTask,
      projectId: 'project-1',
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'Rule',
        eventType: 'story_assigned',
        triggeredBy: {},
        timestamp: new Date().toISOString(),
        fullContent: {},
        autoStart: true,
        _config: {
          startMode: 'execute',
          startInWorktree: false,
        },
      },
    };

    expect(resolveTaskStartInWorktree(taskWithConfig)).toBe(false);
  });

  it('falls back to legacy project_id behavior when config is absent', () => {
    expect(
      resolveTaskStartInWorktree({
        ...baseTask,
        projectId: 'project-1',
      }),
    ).toBe(true);
    expect(resolveTaskStartInWorktree(baseTask)).toBe(false);
  });
});

describe('buildInitialTaskChatName', () => {
  it('removes markdown formatting from the initial task chat title', () => {
    expect(
      buildInitialTaskChatName('⚡ **Type:** Bug\n\n- [Fix login](https://example.com)\n`urgent`'),
    ).toBe('⚡ Type: Bug Fix login urgent');
  });

  it('returns a safe fallback when description is only formatting', () => {
    expect(buildInitialTaskChatName('***   ~~ ~~')).toBe('Task');
  });

  it('normalizes broader markdown patterns likely to appear in trigger text', () => {
    const input = [
      '### Heading',
      '> quoted context',
      '1. [Story link](https://example.com/story/123)',
      '| col | value |',
      '| --- | ----- |',
      '| a   | b     |',
    ].join('\n');

    expect(buildInitialTaskChatName(input)).toBe(
      'Heading quoted context 1. Story link | col | value | | --- | ----- | | a | b |',
    );
  });

  it('caps long titles to 100 characters', () => {
    expect(buildInitialTaskChatName('x'.repeat(200))).toHaveLength(100);
  });

  it('handles unicode without throwing and returns non-empty output', () => {
    const name = buildInitialTaskChatName(
      'Fix emoji parsing 🚀✨🔥 with accents café naïve façade',
    );
    expect(name.length).toBeGreaterThan(0);
  });
});

describe('buildRetryContinuationPrompt', () => {
  it('carries the prior error and asks the agent to re-derive remaining work', () => {
    const prompt = buildRetryContinuationPrompt('API Error: 401 boom');
    expect(prompt).toContain('API Error: 401 boom');
    // Compaction-safe wording: re-derive the done/remaining split, not "continue where left off".
    expect(prompt).toContain('checklist');
    expect(prompt).toContain('task signal');
  });

  it('falls back to a generic stop line when no prior error was recorded', () => {
    const prompt = buildRetryContinuationPrompt(null);
    expect(prompt).toContain('stopped before finishing');
    expect(prompt).toContain('resumed');
  });

  it('always warns that unreturned tool calls did not complete and files may be half-applied', () => {
    // Terminal-resume continuation recovers runs that died MID-WRITE; the warning is true for
    // every failed attempt, so it is unconditional (carry-on benefits too).
    for (const prompt of [
      buildRetryContinuationPrompt('boom'),
      buildRetryContinuationPrompt(null),
    ]) {
      expect(prompt).toContain('did NOT complete');
      expect(prompt).toContain('half-applied');
    }
  });
});

describe('buildTaskPrompt', () => {
  it('does not include lifecycle instruction in user prompt (it lives in system prompt)', () => {
    const task = {
      id: 'task-signal',
      projectId: null,
      title: null,
      description: 'Do work',
      source: 'shortcut',
      sourceId: null,
      executionTarget: 'local',
      requiresFilesystem: false,
      status: 'pending',
      result: null,
      triggerContext: null,
      flowRunId: null,
      nodeRunId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      executedBy: null,
    } satisfies DbTask;

    const prompt = buildTaskPrompt(task);

    // Lifecycle block moved to system prompt (buildFrinkSystemPromptAppend with isTaskExecution: true).
    // The user prompt contains only task content (trigger + description) — the project name is no
    // longer prepended (Claude Code's system prompt already carries the cwd/project).
    expect(prompt).not.toContain('Task lifecycle requirement (MANDATORY):');
    expect(prompt).not.toContain('**Project**');
    expect(prompt).toBe('Do work');
  });

  it('includes trigger bubble marker but omits universal prompt body; description is the work prompt', () => {
    const task = {
      id: 'task-tc',
      projectId: 'proj-1',
      title: null,
      description: 'Custom agent instructions only.',
      source: 'flow',
      sourceId: null,
      executionTarget: 'local',
      requiresFilesystem: true,
      status: 'pending',
      result: null,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'owners-web work',
        eventType: 'story_assigned',
        triggeredBy: { externalUserId: '', name: 'user' },
        timestamp: new Date().toISOString(),
        fullContent: { story: { name: 'Story A', description: 'Desc' } },
        autoStart: true,
      },
      flowRunId: null,
      nodeRunId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      executedBy: null,
    } satisfies DbTask;

    const prompt = buildTaskPrompt(task);

    expect(prompt.startsWith(TRIGGER_BUBBLE_MARKER)).toBe(true);
    expect(prompt).not.toContain('<task_identity>');
    expect(prompt).not.toContain('## Trigger Context: Shortcut Story');
    // Project name is no longer prepended (duplicated the system prompt's cwd/project context).
    expect(prompt).not.toContain('**Project**');
    expect(prompt).toContain('Custom agent instructions only.');
    // Lifecycle block is in system prompt, not user prompt
    expect(prompt).not.toContain('Task lifecycle requirement (MANDATORY):');
  });

  it('with trigger context and empty description: bubble only, no project line, no universal body (lifecycle in system prompt)', () => {
    const task = {
      id: 'task-empty-desc',
      projectId: 'proj-1',
      title: null,
      description: '',
      source: 'flow',
      sourceId: null,
      executionTarget: 'local',
      requiresFilesystem: false,
      status: 'pending',
      result: null,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'rule',
        eventType: 'story:create',
        triggeredBy: { externalUserId: '', name: 'user' },
        timestamp: new Date().toISOString(),
        fullContent: { story: { name: 'S' } },
        autoStart: true,
      },
      flowRunId: null,
      nodeRunId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      executedBy: null,
    } satisfies DbTask;

    const prompt = buildTaskPrompt(task);

    expect(prompt.startsWith(TRIGGER_BUBBLE_MARKER)).toBe(true);
    expect(prompt).not.toContain('<task_identity>');
    expect(prompt).not.toContain('**Project**');
    // Lifecycle block is in system prompt, not user prompt
    expect(prompt).not.toContain('Task lifecycle requirement (MANDATORY):');
  });

  it('omits trigger bubble when _config.showTriggerCard is false (flow agent without {{trigger.*}})', () => {
    const task = {
      id: 'task-no-bubble',
      projectId: 'proj-1',
      title: null,
      description: 'Follow-up work only.',
      source: 'flow',
      sourceId: null,
      executionTarget: 'local',
      requiresFilesystem: true,
      status: 'pending',
      result: null,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'rule',
        eventType: 'story:create',
        triggeredBy: { externalUserId: '', name: 'user' },
        timestamp: new Date().toISOString(),
        fullContent: { story: { name: 'S' } },
        autoStart: true,
        _config: { showTriggerCard: false },
      },
      flowRunId: null,
      nodeRunId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      executedBy: null,
    } satisfies DbTask;

    const prompt = buildTaskPrompt(task);

    expect(prompt.startsWith(TRIGGER_BUBBLE_MARKER)).toBe(false);
    expect(prompt).toContain('Follow-up work only.');
    // Lifecycle block is in system prompt, not user prompt
    expect(prompt).not.toContain('Task lifecycle requirement (MANDATORY):');
  });

  it('includes trigger bubble when _config.showTriggerCard is true', () => {
    const task = {
      id: 'task-bubble-on',
      projectId: 'proj-1',
      title: null,
      description: 'Use trigger data.',
      source: 'flow',
      sourceId: null,
      executionTarget: 'local',
      requiresFilesystem: true,
      status: 'pending',
      result: null,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'rule',
        eventType: 'story:create',
        triggeredBy: { externalUserId: '', name: 'user' },
        timestamp: new Date().toISOString(),
        fullContent: { story: { name: 'S' } },
        autoStart: true,
        _config: { showTriggerCard: true },
      },
      flowRunId: null,
      nodeRunId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      executedBy: null,
    } satisfies DbTask;

    const prompt = buildTaskPrompt(task);

    expect(prompt.startsWith(TRIGGER_BUBBLE_MARKER)).toBe(true);
    expect(prompt).toContain('Use trigger data.');
    // Lifecycle block is in system prompt, not user prompt
    expect(prompt).not.toContain('Task lifecycle requirement (MANDATORY):');
  });

  it('omits trigger bubble when _config.showTriggerCard is non-boolean (invalid trigger_context)', () => {
    const task = {
      id: 'task-bad-flag-type',
      userId: 'user-1',
      projectId: 'proj-1',
      title: null,
      description: 'Work',
      source: 'flow',
      sourceId: null,
      executionTarget: 'local',
      requiresFilesystem: true,
      status: 'pending',
      result: null,
      triggerContext: {
        source: 'shortcut',
        sourceAccountId: 'acc-1',
        sourceAccountName: 'Shortcut',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'rule',
        eventType: 'story:create',
        triggeredBy: { externalUserId: '', name: 'user' },
        timestamp: new Date().toISOString(),
        fullContent: { story: { name: 'S' } },
        autoStart: true,
        _config: { showTriggerCard: 'false' },
      },
      flowRunId: null,
      nodeRunId: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      executedBy: null,
    } as unknown as DbTask;

    const prompt = buildTaskPrompt(task);

    expect(prompt.startsWith(TRIGGER_BUBBLE_MARKER)).toBe(false);
    expect(prompt).toContain('Work');
    // Lifecycle block is in system prompt, not user prompt
    expect(prompt).not.toContain('Task lifecycle requirement (MANDATORY):');
  });
});

describe('isStartTaskFallbackMode', () => {
  it('returns true for executionMode: start_task in _config', () => {
    const ctx = {
      _config: { executionMode: 'start_task' },
    } as unknown as DbTask['triggerContext'];
    expect(isStartTaskFallbackMode(ctx)).toBe(true);
  });

  it('returns false for executionMode: shell', () => {
    const ctx = { _config: { executionMode: 'shell' } } as unknown as DbTask['triggerContext'];
    expect(isStartTaskFallbackMode(ctx)).toBe(false);
  });

  it('returns false for executionMode: continue_chat', () => {
    const ctx = {
      _config: { executionMode: 'continue_chat' },
    } as unknown as DbTask['triggerContext'];
    expect(isStartTaskFallbackMode(ctx)).toBe(false);
  });

  it('returns false when no executionMode is set', () => {
    const ctx = { _config: {} } as unknown as DbTask['triggerContext'];
    expect(isStartTaskFallbackMode(ctx)).toBe(false);
  });

  it('returns false when trigger_context is null', () => {
    expect(isStartTaskFallbackMode(null)).toBe(false);
  });

  it('returns false when trigger_context has no _config', () => {
    const ctx = {} as unknown as DbTask['triggerContext'];
    expect(isStartTaskFallbackMode(ctx)).toBe(false);
  });
});
