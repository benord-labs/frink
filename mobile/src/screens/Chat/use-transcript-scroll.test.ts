import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScrollView, View } from 'react-native';

const lifecycle = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
// Exercise the hook's event handlers against a deferred native measurement bridge without
// mounting a renderer. State rendering is covered by the transcript browser tests.
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => () => void) => lifecycle.cleanups.push(effect()),
}));
vi.mock('react-native', () => ({}));

import { useTranscriptScroll } from './use-transcript-scroll';

afterEach(() => {
  lifecycle.cleanups.splice(0).forEach((cleanup) => cleanup());
});

function nativeTranscript(decision = false) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- The lifecycle above replaces React only for native bridge ordering tests.
  const hook = useTranscriptScroll(
    true,
    decision ? { type: 'question', id: 'q1' } : undefined,
    decision,
  );
  let offset = 0;
  let top = 100;
  const pending: Array<() => void> = [];
  const view = {
    measureInWindow: vi.fn(
      (callback: (x: number, y: number, width: number, height: number) => void) => {
        const measuredY = top - offset;
        pending.push(() => callback(0, measuredY, 300, 80));
      },
    ),
  } as unknown as View;
  const host = {
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
      callback(0, 0, 300, 600),
  };
  const scrollTo = vi.fn(({ y }: { y: number }) => {
    offset = y;
  });
  hook.scrollRef.current = {
    getNativeScrollRef: () => host,
    scrollTo,
    scrollToEnd: vi.fn(),
  } as unknown as ScrollView;
  hook.registerMessage('message', view);
  if (decision) hook.registerDecision('question', 'q1', view);
  return {
    hook,
    pending,
    scrollTo,
    prepend: () => {
      top += 300;
    },
    flush: () => pending.shift()!(),
  };
}

async function capture(transcript: ReturnType<typeof nativeTranscript>) {
  const capturing = transcript.hook.captureHistory();
  await Promise.resolve();
  transcript.flush();
  await capturing;
}

describe('native transcript measurement ordering', () => {
  it('coalesces overlapping layouts and measures again after the first scroll correction', async () => {
    const transcript = nativeTranscript();
    await capture(transcript);
    transcript.prepend();
    const restoring = transcript.hook.restorePosition();
    void transcript.hook.restorePosition();
    void transcript.hook.restorePosition();
    expect(transcript.pending).toHaveLength(1);
    transcript.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(transcript.scrollTo).toHaveBeenLastCalledWith({ y: 300, animated: false });
    expect(transcript.pending).toHaveLength(1);
    transcript.flush();
    await restoring;
    expect(transcript.scrollTo.mock.calls.map(([position]) => position.y)).toEqual([300, 300]);
  });

  it.each(['gesture', 'reset', 'latest', 'unmount'] as const)(
    'discards in-flight and queued corrections after %s',
    async (action) => {
      const transcript = nativeTranscript();
      await capture(transcript);
      transcript.prepend();
      const restoring = transcript.hook.restorePosition();
      void transcript.hook.restorePosition();
      if (action === 'gesture') transcript.hook.scrollProps.onScrollBeginDrag!(null as never);
      else if (action === 'unmount') lifecycle.cleanups.splice(0).forEach((cleanup) => cleanup());
      else transcript.hook[action]();
      transcript.flush();
      await restoring;
      expect(transcript.scrollTo).not.toHaveBeenCalled();
      expect(transcript.pending).toHaveLength(0);
    },
  );

  it('does not restore an earlier conversation anchor captured before a reset', async () => {
    const transcript = nativeTranscript();
    const capturing = transcript.hook.captureHistory();
    await Promise.resolve();
    transcript.hook.reset();
    transcript.flush();
    await capturing;
    await transcript.hook.restorePosition();
    expect(transcript.pending).toHaveLength(0);
    expect(transcript.scrollTo).not.toHaveBeenCalled();
  });

  it('allows a new conversation to scroll before the old native measurement returns', async () => {
    const transcript = nativeTranscript();
    await capture(transcript);
    transcript.prepend();
    const restoring = transcript.hook.restorePosition();
    transcript.hook.reset();
    await transcript.hook.restorePosition();
    expect(transcript.hook.scrollRef.current!.scrollToEnd).toHaveBeenCalled();
    transcript.flush();
    await restoring;
    expect(transcript.scrollTo).not.toHaveBeenCalled();
  });

  it('cancels a queued decision focus when the reader starts scrolling', async () => {
    const transcript = nativeTranscript(true);
    const restoring = transcript.hook.restorePosition();
    void transcript.hook.restorePosition();
    transcript.hook.scrollProps.onScrollBeginDrag!(null as never);
    transcript.flush();
    await restoring;
    expect(transcript.scrollTo).not.toHaveBeenCalled();
    expect(transcript.pending).toHaveLength(0);
  });
});
