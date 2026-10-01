import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { subscribeSessionCompletions } from './completion-events';
import {
  _clearActiveExecutionsForTests,
  setActiveExecution,
  getExecutionStreamEpoch,
} from '../execution-registry';
import {
  _clearLiveStreamRegistryForTests,
  armLiveStreamNotification,
  beginLiveStreamCompletion,
  finishHeldLiveStreams,
  recordLiveStreamStart,
  recordLiveStreamChunk,
  settleLiveStreamCompletion,
} from './registry';

const completed = vi.fn();
let unsubscribe: () => void;
const controller = () => new AbortController();
beforeEach(() => {
  _clearActiveExecutionsForTests();
  _clearLiveStreamRegistryForTests();
  completed.mockClear();
  unsubscribe = subscribeSessionCompletions(completed);
});
afterEach(() => unsubscribe());
function start() {
  const run = controller();
  setActiveExecution('sub', run, 1, { chatId: 'chat', assistantMessageId: 'msg' });
  const event = {
    chatId: 'chat',
    subChatId: 'sub',
    assistantMessageId: 'msg',
    streamEpoch: getExecutionStreamEpoch('sub')!,
  };
  recordLiveStreamStart(event);
  armLiveStreamNotification(event, run.signal);
  return { run, event };
}
it('notifies once after durable completion', () => {
  const { event } = start();
  beginLiveStreamCompletion({ ...event, continuesWakeHold: false });
  settleLiveStreamCompletion({ ...event, terminalDurability: { durability: 'committed' } });
  settleLiveStreamCompletion(event);
  expect(completed).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat', subChatId: 'sub' });
});
it('retains eligibility through held wake chunks until final settlement', () => {
  const { event } = start();
  beginLiveStreamCompletion({ ...event, continuesWakeHold: true });
  expect(settleLiveStreamCompletion(event)).toBe(false);
  recordLiveStreamChunk({
    ...event,
    messageIndex: 1,
    chunk: { type: 'text-delta', delta: 'done' },
    wakeBurst: true,
  });
  beginLiveStreamCompletion({ ...event, continuesWakeHold: true });
  expect(completed).not.toHaveBeenCalled();
  finishHeldLiveStreams('sub');
  settleLiveStreamCompletion({ ...event, terminalDurability: { durability: 'committed' } });
  expect(completed).toHaveBeenCalledOnce();
});
it.each(['abort', 'superseded', 'non-durable', 'not-armed', 'late-failure'])(
  'does not notify for %s completion',
  (reason) => {
    const { run, event } = start();
    if (reason === 'not-armed') recordLiveStreamStart(event);
    if (reason === 'late-failure') armLiveStreamNotification(event, undefined);
    beginLiveStreamCompletion({ ...event, continuesWakeHold: false });
    if (reason === 'abort') run.abort();
    if (reason === 'superseded') start();
    settleLiveStreamCompletion({
      ...event,
      terminalDurability: { durability: reason === 'non-durable' ? 'non-durable' : 'committed' },
    });
    expect(completed).not.toHaveBeenCalled();
  },
);
