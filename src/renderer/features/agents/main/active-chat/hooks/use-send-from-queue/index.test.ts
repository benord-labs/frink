// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetLiveRunHydrationForTests,
  beginLiveRunHydration,
  completeLiveRunHydration,
} from '@/lib/stores/renderer-recovery-ready';
import {
  type AgentQueueItem,
  createQueueItem,
  FLOW_DISPATCH_SOURCE,
  type QueuedSendMessage,
  queueItemToSendMessage,
} from '../../../../lib/queue-utils';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';
import { ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND } from '../../utils';
import { useSendFromQueue } from './index';

const SUB = 'sub-1';

type Props = Parameters<typeof useSendFromQueue>[0];

function setup(items: AgentQueueItem[], overrides: Partial<Props> = {}) {
  useMessageQueueStore.setState({ queues: { [SUB]: items }, editingItemIds: {} });
  const sendMessage = vi.fn(async (_message: QueuedSendMessage) => undefined);
  const steerOrQueue = vi.fn<Props['steerOrQueue']>(async () => undefined);
  const props: Props = {
    subChatId: SUB,
    parentChatId: 'chat-1',
    chatModeRef: { current: 'agent' },
    isStreamingRef: { current: false },
    isMountedRef: { current: true },
    sendMessageRef: { current: sendMessage },
    steerOrQueue,
    handleStop: vi.fn(async () => undefined),
    handleAbandonEdit: vi.fn(),
    scrollToBottom: vi.fn(),
    clearExpiredQuestionsForSubChat: vi.fn(),
    isResolvedExecutionAccountReady: true,
    ...overrides,
  };
  const { result } = renderHook(() => useSendFromQueue(props));
  return { send: result.current, sendMessage, steerOrQueue, props };
}

const queued = () => useMessageQueueStore.getState().queues[SUB] ?? [];

const dispatchItem = (): AgentQueueItem => ({
  ...createQueueItem(
    'q-flow',
    'flow prompt',
    [{ id: 'i', url: '', mediaType: 'image/png', base64Data: 'QUJD' }],
    [{ id: 'f', url: 'blob:file', filename: 'notes.txt' }],
  ),
  source: FLOW_DISPATCH_SOURCE,
  dispatchTaskId: 'task-1',
});

describe('useSendFromQueue', () => {
  beforeEach(() => {
    _resetLiveRunHydrationForTests();
    completeLiveRunHydration();
    vi.spyOn(toast, 'error').mockImplementation(() => '');
    vi.spyOn(toast, 'info').mockImplementation(() => '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetLiveRunHydrationForTests();
  });

  it('sends exactly what the shared builder produces, files and dispatch metadata included', async () => {
    const item = dispatchItem();
    const { send, sendMessage } = setup([item]);

    await send(item.id, false);

    const expected = queueItemToSendMessage(item).message;
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expected);
    expect(expected.metadata).toEqual({ source: 'flow-dispatch', dispatchTaskId: 'task-1' });
    expect(expected.parts.map((p) => p.type)).toEqual(['data-image', 'data-file', 'text']);
    expect(queued()).toEqual([]);
  });

  it('sends a typed message without metadata', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item]);

    await send(item.id, false);

    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
  });

  it('drops an empty item with a toast instead of sending or requeueing it', async () => {
    const item = createQueueItem('q', '  ');
    const { send, sendMessage } = setup([item]);

    await send(item.id, false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('A queued message was empty and was not sent.');
    expect(queued()).toEqual([]);
  });

  it('steers a typed message into the running turn', async () => {
    const item = createQueueItem('q', 'also do this');
    const { send, sendMessage, steerOrQueue } = setup([item], {
      isStreamingRef: { current: true },
    });

    await send(item.id, true);

    expect(steerOrQueue).toHaveBeenCalledWith('also do this', undefined, expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('puts a dispatched prompt back at the head rather than steering it', async () => {
    const item = dispatchItem();
    const behind = createQueueItem('q-behind', 'later');
    const { send, sendMessage, steerOrQueue, props } = setup([item, behind], {
      isStreamingRef: { current: true },
    });

    await send(item.id, true);

    expect(steerOrQueue).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q-flow', 'q-behind']);
    expect(toast.info).toHaveBeenCalledWith(
      'This message will be sent when the current step finishes.',
    );
    expect(props.scrollToBottom).not.toHaveBeenCalled();
    expect(queued()[0]).toMatchObject({ source: 'flow-dispatch', dispatchTaskId: 'task-1' });
  });

  it('holds a message with attached files instead of steering it without them', async () => {
    const item = createQueueItem('q-files', 'see attached', undefined, [
      { id: 'f', url: 'blob:file', filename: 'notes.txt' },
    ]);
    const { send, sendMessage, steerOrQueue } = setup([item], {
      isStreamingRef: { current: true },
    });

    await send(item.id, true);

    expect(steerOrQueue).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued()[0]?.files).toHaveLength(1);
  });

  it('stops the running turn first when the runtime cannot steer, then sends with metadata', async () => {
    const item = dispatchItem();
    const { send, sendMessage, props } = setup([item], { isStreamingRef: { current: true } });

    await send(item.id, false);

    expect(props.handleStop).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(queueItemToSendMessage(item).message);
  });

  it('requeues while live runs are still hydrating', async () => {
    beginLiveRunHydration();
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item]);

    await send(item.id, true);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('requeues when the send fails', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item]);
    sendMessage.mockRejectedValueOnce(new Error('offline'));

    await send(item.id, false);

    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('requeues when the view unmounted before the send', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item], { isMountedRef: { current: false } });

    await send(item.id, false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('leaves the queue alone and asks for sign-in when the account is not ready', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item], { isResolvedExecutionAccountReady: false });

    await send(item.id, false);

    expect(toast.error).toHaveBeenCalledWith(
      ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
      expect.anything(),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('abandons the composer edit when the item being edited is sent', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, props } = setup([item]);
    useMessageQueueStore.setState({ editingItemIds: { [SUB]: 'q' } });

    await send(item.id, false);

    expect(props.handleAbandonEdit).toHaveBeenCalledOnce();
  });

  it('sends a dispatched prompt straight away when the chat is idle, even if the card could steer', async () => {
    const item = dispatchItem();
    const { send, sendMessage, steerOrQueue } = setup([item]);

    await send(item.id, true);

    expect(steerOrQueue).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(queueItemToSendMessage(item).message);
    expect(queued()).toEqual([]);
  });

  it('puts the item back exactly once when the steer is refused', async () => {
    const item = createQueueItem('q', 'also do this');
    const behind = createQueueItem('q-behind', 'later');
    const { send, sendMessage, steerOrQueue } = setup([item, behind], {
      isStreamingRef: { current: true },
    });
    steerOrQueue.mockImplementationOnce(async (_text, _images, requeue) => requeue());

    await send(item.id, true);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q', 'q-behind']);
  });

  it('sends once when the same item is sent twice at the same moment', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item]);

    await Promise.all([send(item.id, false), send(item.id, false)]);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(queued()).toEqual([]);
  });

  it('does nothing for an item that is no longer queued', async () => {
    const { send, sendMessage, props } = setup([createQueueItem('q', 'hello')]);

    await send('gone', false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(props.handleAbandonEdit).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('never sends a turn that lost an attachment in a reload', async () => {
    const item = { ...createQueueItem('q', 'see attached'), attachmentsLost: true as const };
    const { send, sendMessage } = setup([item]);

    await send(item.id, false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('requeues when stopping the running turn fails', async () => {
    const item = createQueueItem('q', 'hello');
    const { send, sendMessage } = setup([item], {
      isStreamingRef: { current: true },
      handleStop: vi.fn(async () => {
        throw new Error('stop failed');
      }),
    });

    await send(item.id, false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(queued().map((i) => i.id)).toEqual(['q']);
  });

  it('keeps one callback across renders and reads the latest account state', async () => {
    const item = createQueueItem('q', 'hello');
    useMessageQueueStore.setState({ queues: { [SUB]: [item] }, editingItemIds: {} });
    const sendMessage = vi.fn(async (_message: QueuedSendMessage) => undefined);
    const base: Props = {
      subChatId: SUB,
      parentChatId: 'chat-1',
      chatModeRef: { current: 'agent' },
      isStreamingRef: { current: false },
      isMountedRef: { current: true },
      sendMessageRef: { current: sendMessage },
      steerOrQueue: vi.fn(async () => undefined),
      handleStop: vi.fn(async () => undefined),
      handleAbandonEdit: vi.fn(),
      scrollToBottom: vi.fn(),
      clearExpiredQuestionsForSubChat: vi.fn(),
      isResolvedExecutionAccountReady: false,
    };
    const { result, rerender } = renderHook((p: Props) => useSendFromQueue(p), {
      initialProps: base,
    });
    const first = result.current;

    rerender({ ...base, isResolvedExecutionAccountReady: true });
    await first(item.id, false);

    expect(result.current).toBe(first);
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
