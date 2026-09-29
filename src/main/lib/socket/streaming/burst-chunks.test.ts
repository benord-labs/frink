import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { burstPlanSubmissionAttempt, emitBurstPlanCard } from './burst-chunks';

const toolInput = (toolCallId: string, toolName: string): UIMessageChunk => ({
  type: 'tool-input-available',
  toolCallId,
  toolName,
  input: {},
});

const text = (value: string): UIMessageChunk => ({ type: 'text-delta', id: 't', delta: value });

describe('burstPlanSubmissionAttempt', () => {
  it('finds an ExitPlanMode this burst attempted and was denied', () => {
    const chunks = [text('drafting'), toolInput('exit-1', 'ExitPlanMode')];
    const denied = new Map([['exit-1', 'denied']]);
    expect(burstPlanSubmissionAttempt(chunks, 0, denied)).toBe('exit-1');
  });

  it('matches a composite parent:child tool id, as the denial backfill does', () => {
    const chunks = [toolInput('parent:exit-1', 'ExitPlanMode')];
    const denied = new Map([['exit-1', 'denied']]);
    expect(burstPlanSubmissionAttempt(chunks, 0, denied)).toBe('parent:exit-1');
  });

  it('ignores an attempt below startIndex — an earlier burst already handled its own', () => {
    const chunks = [toolInput('exit-1', 'ExitPlanMode'), text('this burst said nothing')];
    const denied = new Map([['exit-1', 'denied']]);
    expect(burstPlanSubmissionAttempt(chunks, 1, denied)).toBeNull();
  });

  it('ignores an ExitPlanMode that was not denied', () => {
    const chunks = [toolInput('exit-1', 'ExitPlanMode')];
    expect(burstPlanSubmissionAttempt(chunks, 0, new Map())).toBeNull();
  });

  it('ignores other denied tools', () => {
    const chunks = [toolInput('bash-1', 'Bash')];
    const denied = new Map([['bash-1', 'denied']]);
    expect(burstPlanSubmissionAttempt(chunks, 0, denied)).toBeNull();
  });

  it('is empty-safe at the range boundary — a burst that streamed nothing', () => {
    const denied = new Map([['exit-1', 'denied']]);
    expect(burstPlanSubmissionAttempt([], 0, denied)).toBeNull();
    // startIndex === length is the ordinary shape of a burst with no chunks of its own.
    const chunks = [toolInput('exit-1', 'ExitPlanMode')];
    expect(burstPlanSubmissionAttempt(chunks, chunks.length, denied)).toBeNull();
    expect(burstPlanSubmissionAttempt(chunks, chunks.length + 5, denied)).toBeNull();
  });

  it('finds the attempt among the real chunk mix a burst produces', () => {
    // Reasoning text, an allowed tool with its output, then the denied submission last.
    const chunks: UIMessageChunk[] = [
      text('let me finish the plan'),
      toolInput('write-1', 'Write'),
      { type: 'tool-output-available', toolCallId: 'write-1', output: { success: true } },
      toolInput('exit-1', 'ExitPlanMode'),
      {
        type: 'tool-output-error',
        toolCallId: 'exit-1',
        errorText: 'denied',
        permissionDenied: true,
      },
    ];
    const denied = new Map([['exit-1', 'denied']]);
    // The backfill already closed the row before the detector runs; that must not hide the attempt.
    expect(burstPlanSubmissionAttempt(chunks, 0, denied)).toBe('exit-1');
  });
});

describe('emitBurstPlanCard', () => {
  const params = (overrides: {
    planAutoApprove?: boolean;
    planAlreadySubmitted?: boolean;
    denied?: Map<string, string>;
  }) => {
    const streamChunk = vi.fn();
    const onSubmitted = vi.fn();
    return {
      streamChunk,
      onSubmitted,
      args: {
        chatId: 'chat-1',
        subChatId: 'sub-1',
        msgId: 'msg-1',
        chunks: [toolInput('exit-1', 'ExitPlanMode')],
        startIndex: 0,
        deniedToolIdsWithMessages: overrides.denied ?? new Map([['exit-1', 'denied']]),
        flowDriven: false,
        planAutoApprove: overrides.planAutoApprove ?? false,
        planAlreadySubmitted: overrides.planAlreadySubmitted ?? false,
        waitStartedMs: 0,
        nextMessageIndex: () => 7,
        streamChunk,
        onSubmitted,
      },
    };
  };

  it('skips an auto-approved flow node: it has no human approver to show a card to', async () => {
    const { args, streamChunk, onSubmitted } = params({ planAutoApprove: true });
    await emitBurstPlanCard(args);
    expect(streamChunk).not.toHaveBeenCalled();
    // Raising the halt here would strand the node tool-less with nobody able to approve it.
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('does nothing when the burst never attempted a submission', async () => {
    const { args, streamChunk, onSubmitted } = params({ denied: new Map() });
    await emitBurstPlanCard(args);
    expect(streamChunk).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('cards a plan once: a re-attempt after the halt is up does not card it again', async () => {
    const { args, streamChunk, onSubmitted } = params({ planAlreadySubmitted: true });
    await emitBurstPlanCard(args);
    expect(streamChunk).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
