import { describe, expect, it } from 'vitest';

import { normalizePlanHaltFinishChunk, shouldDropPostPlanChunkFromHistory } from './plan-mode-halt';

describe('shouldDropPostPlanChunkFromHistory', () => {
  const exitId = 'exit-1';

  it('drops renderable chunks the model races in after plan submission (reload == live view)', () => {
    const write = { type: 'tool-input-available', toolCallId: 'w1', toolName: 'Write', input: {} };
    const text = { type: 'text-delta', id: 't1', delta: 'continuing...' };
    const reasoning = { type: 'reasoning-delta', id: 'r1', delta: 'thinking' };
    expect(shouldDropPostPlanChunkFromHistory(write as never, exitId)).toBe(true);
    expect(shouldDropPostPlanChunkFromHistory(text as never, exitId)).toBe(true);
    expect(shouldDropPostPlanChunkFromHistory(reasoning as never, exitId)).toBe(true);
  });

  it('keeps stream-control chunks (finish carries the sessionId the approval-resume needs)', () => {
    const finish = { type: 'finish', messageMetadata: { sessionId: 's1' } };
    const finishStep = { type: 'finish-step' };
    const metadata = { type: 'message-metadata', messageMetadata: { sessionId: 's1' } };
    expect(shouldDropPostPlanChunkFromHistory(finish as never, exitId)).toBe(false);
    expect(shouldDropPostPlanChunkFromHistory(finishStep as never, exitId)).toBe(false);
    expect(shouldDropPostPlanChunkFromHistory(metadata as never, exitId)).toBe(false);
  });

  it('keeps the ExitPlanMode output chunk itself (the canonical plan filters hide its row)', () => {
    const exitOutput = { type: 'tool-output-available', toolCallId: exitId, output: {} };
    expect(shouldDropPostPlanChunkFromHistory(exitOutput as never, exitId)).toBe(false);
  });
});

describe('normalizePlanHaltFinishChunk', () => {
  it('rewrites a non-success resultSubtype to success (the halt interrupt is not a failure)', () => {
    const finish = {
      type: 'finish',
      messageMetadata: { sessionId: 's1', resultSubtype: 'error_during_execution' },
    };
    const result = normalizePlanHaltFinishChunk(finish as never) as {
      messageMetadata: { resultSubtype: string; sessionId: string };
    };
    expect(result.messageMetadata.resultSubtype).toBe('success');
    expect(result.messageMetadata.sessionId).toBe('s1');
  });

  it('returns success finishes and non-finish chunks unchanged', () => {
    const success = { type: 'finish', messageMetadata: { resultSubtype: 'success' } };
    const text = { type: 'text-delta', id: 't1', delta: 'x' };
    expect(normalizePlanHaltFinishChunk(success as never)).toBe(success);
    expect(normalizePlanHaltFinishChunk(text as never)).toBe(text);
  });
});
