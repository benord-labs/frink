import { describe, expect, it } from 'vitest';
import type { MobileChatChanges } from '@frink/shared/types/remote/mobile';
import { askChanges, nextAnswer, ownAnswer, type ChangesAnswer } from './ask';

const changes: MobileChatChanges = {
  additions: 3,
  deletions: 1,
  fileCount: 1,
  files: [],
  truncated: false,
};

function deferred() {
  let settle = { resolve: (_: MobileChatChanges) => {}, reject: (_: Error) => {} };
  const promise = new Promise<MobileChatChanges>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

describe('askChanges', () => {
  it('reports the answer, or the failure in words', async () => {
    const answers: Omit<ChangesAnswer, 'key'>[] = [];
    askChanges(
      () => Promise.resolve(changes),
      (answer) => answers.push(answer),
    );
    askChanges(
      () => Promise.reject(new Error('Offline')),
      (answer) => answers.push(answer),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(answers).toEqual([{ data: changes }, { error: 'Offline' }]);
  });

  it('reports nothing once cancelled, and aborts the request', async () => {
    const pending = deferred();
    const signals: AbortSignal[] = [];
    const answers: Omit<ChangesAnswer, 'key'>[] = [];
    const cancel = askChanges(
      (signal) => {
        signals.push(signal);
        return pending.promise;
      },
      (answer) => answers.push(answer),
    );
    cancel();
    pending.resolve(changes);
    await pending.promise;
    expect(signals[0]?.aborted).toBe(true);
    expect(answers).toEqual([]);
  });
});

describe('nextAnswer', () => {
  it('keeps the last answer for the same chat under a failure', () => {
    const old = { key: 'computer-1\nchat-1', data: changes };
    expect(nextAnswer(old, 'computer-1\nchat-1', { error: 'Offline' })).toEqual({
      ...old,
      error: 'Offline',
    });
  });

  it('never shows another computer or chat’s answer', () => {
    const old = { key: 'computer-1\nchat-1', data: changes };
    expect(nextAnswer(old, 'computer-2\nchat-1', { error: 'Offline' })).toEqual({
      key: 'computer-2\nchat-1',
      data: undefined,
      error: 'Offline',
    });
  });

  it('replaces an error with a fresh answer', () => {
    const old = { key: 'k', error: 'Offline' };
    expect(nextAnswer(old, 'k', { data: changes })).toEqual({ key: 'k', data: changes });
  });
});

describe('ownAnswer', () => {
  it('shows an answer only for the computer and chat it was asked about', () => {
    const answer = { key: 'computer-1\nchat-1', data: changes, error: 'Offline' };
    expect(ownAnswer(answer, 'computer-1\nchat-1')).toEqual({ data: changes, error: 'Offline' });
    expect(ownAnswer(answer, 'computer-2\nchat-1')).toEqual({});
    expect(ownAnswer(undefined, 'computer-1\nchat-1')).toEqual({});
  });
});
