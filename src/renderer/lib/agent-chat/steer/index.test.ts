import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../../jotai-store';
import { runSettlingAtomFamily } from '../../stores/active-transport-registry';
import { useSteerOrQueue } from './index';

const mutate = vi.fn();
vi.mock('../../trpc', () => ({
  trpcClient: { socket: { steerMessage: { mutate: (input: unknown) => mutate(input) } } },
}));

const toastInfo = vi.fn();
vi.mock('sonner', () => ({ toast: { info: (m: string) => toastInfo(m) } }));

// The hooks only wrap their body in useCallback; calling it outside React is enough to exercise the
// delivery contract, which is the part with real branches.
vi.mock('react', () => ({ useCallback: <T>(fn: T) => fn }));

describe('useSteerOrQueue', () => {
  beforeEach(() => {
    mutate.mockReset();
    toastInfo.mockReset();
  });

  it('does not requeue or warn when the agent took the steer', async () => {
    mutate.mockResolvedValue({ success: true, outcome: 'delivered' });
    const requeue = vi.fn();

    await useSteerOrQueue('sub-1')('use the other file', undefined, requeue);

    expect(mutate).toHaveBeenCalledWith({ subChatId: 'sub-1', text: 'use the other file' });
    expect(requeue).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  // Every non-delivery must reach the QUEUE. A direct send would hit the executor's
  // duplicate-request guard and abort the very turn the user was steering.
  it.each([
    ['a refused steer', { success: true, outcome: 'not-steerable' }],
    ['an unsupported runtime', { success: true, outcome: 'unsupported' }],
    ['a failed mutation', { success: false, reason: 'boom' }],
  ])('requeues and warns on %s', async (_label, response) => {
    mutate.mockResolvedValue(response);
    const requeue = vi.fn();

    await useSteerOrQueue('sub-1')('hi', undefined, requeue);

    expect(requeue).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('queues without steering or warning while main only settles a turn whose stream closed', async () => {
    appStore.set(runSettlingAtomFamily('sub-1'), true);
    const requeue = vi.fn();

    await useSteerOrQueue('sub-1')('hi', undefined, requeue);
    appStore.set(runSettlingAtomFamily('sub-1'), false);

    expect(mutate).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('requeues when the call throws — main never got the message either way', async () => {
    mutate.mockRejectedValue(new Error('ipc down'));
    const requeue = vi.fn();

    await useSteerOrQueue('sub-1')('hi', undefined, requeue);

    expect(requeue).toHaveBeenCalledTimes(1);
  });

  it('queues an attachment-only message without calling main (nothing to steer with)', async () => {
    const requeue = vi.fn();

    await useSteerOrQueue('sub-1')('   ', [{ mediaType: 'image/png', base64Data: 'x' }], requeue);

    expect(mutate).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledTimes(1);
  });

  it('sends the attachments along when every one has inline bytes', async () => {
    mutate.mockResolvedValue({ success: true, outcome: 'delivered' });

    await useSteerOrQueue('sub-1')(
      'look',
      [
        { mediaType: 'image/png', base64Data: 'a' },
        { mediaType: 'image/jpeg', base64Data: 'b' },
      ],
      vi.fn(),
    );

    expect(mutate).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      text: 'look',
      imageParts: [
        { mediaType: 'image/png', base64Data: 'a' },
        { mediaType: 'image/jpeg', base64Data: 'b' },
      ],
    });
  });

  // Sending the carryable subset would silently drop the rest of what the user attached, so an
  // unattachable image sends the WHOLE message down the queue instead.
  it.each([
    ['one is still loading', { mediaType: 'image/png', base64Data: 'x', isLoading: true }],
    ['one is URL-backed with no bytes', { mediaType: 'image/png' }],
  ])('queues the whole message when %s', async (_label, bad) => {
    const requeue = vi.fn();

    await useSteerOrQueue('sub-1')(
      'look',
      [{ mediaType: 'image/png', base64Data: 'a' }, bad],
      requeue,
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledTimes(1);
  });
});
