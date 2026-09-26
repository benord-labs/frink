import { describe, expect, it, vi } from 'vitest';
import { askAgent, createPr, type GitContextIo, startReview } from '.';

const PR_CONTEXT = {
  branch: 'feature',
  baseBranch: 'main',
  uncommittedCount: 0,
  hasUpstream: true,
};

function fakeIo(overrides: Partial<GitContextIo> = {}): GitContextIo {
  return { getPrContext: async () => PR_CONTEXT, notifyError: () => undefined, ...overrides };
}

describe('createPr', () => {
  it('keeps the creating flag set after handing the message to the chat', async () => {
    const setIsCreatingPr = vi.fn();
    const setPendingPrMessage = vi.fn();
    await createPr({ chatId: 'c1', setPendingPrMessage, setIsCreatingPr }, fakeIo());
    expect(setPendingPrMessage).toHaveBeenCalledWith(expect.stringContaining('feature'));
    expect(setIsCreatingPr).toHaveBeenCalledTimes(1);
    expect(setIsCreatingPr).toHaveBeenCalledWith(true);
  });

  it('releases the creating flag and reports when the context fetch fails', async () => {
    const notifyError = vi.fn();
    const setIsCreatingPr = vi.fn();
    await createPr(
      { chatId: 'c1', setPendingPrMessage: vi.fn(), setIsCreatingPr },
      fakeIo({ getPrContext: () => Promise.reject(new Error('offline')), notifyError }),
    );
    expect(notifyError).toHaveBeenCalledWith('offline');
    expect(setIsCreatingPr).toHaveBeenLastCalledWith(false);
  });
});

describe('askAgent', () => {
  it('queues the built message and releases the busy flag', async () => {
    const setBusy = vi.fn();
    const setPendingMessage = vi.fn();
    await askAgent(
      { chatId: 'c1', buildMessage: (c) => `commit ${c.branch}`, setPendingMessage, setBusy },
      fakeIo(),
    );
    expect(setPendingMessage).toHaveBeenCalledWith('commit feature');
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });

  it('reports a failed context lookup without queueing anything', async () => {
    const notifyError = vi.fn();
    const setPendingMessage = vi.fn();
    await askAgent(
      { chatId: 'c1', buildMessage: () => 'x', setPendingMessage, setBusy: vi.fn() },
      fakeIo({ getPrContext: () => Promise.reject(new Error('offline')), notifyError }),
    );
    expect(notifyError).toHaveBeenCalledWith('offline');
    expect(setPendingMessage).not.toHaveBeenCalled();
  });
});

describe('startReview', () => {
  it('reports a missing git context and releases the reviewing flag', async () => {
    const notifyError = vi.fn();
    const setIsReviewing = vi.fn();
    const setPendingReviewMessage = vi.fn();
    await startReview(
      {
        chatId: 'c1',
        effectiveActiveSubChatId: 'sc1',
        setFilteredSubChatId: vi.fn(),
        setPendingReviewMessage,
        setIsReviewing,
      },
      fakeIo({ getPrContext: async () => null, notifyError }),
    );
    expect(notifyError).toHaveBeenCalledWith('Could not get git context');
    expect(setPendingReviewMessage).not.toHaveBeenCalled();
    expect(setIsReviewing).toHaveBeenLastCalledWith(false);
  });
});
