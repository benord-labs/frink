import { useEffect, useRef, useState } from 'react';
import { ScrollView, View, type ScrollViewProps } from 'react-native';

export type DecisionTarget = { type: 'question' | 'permission'; id: string };
type Position = { id: string; y: number; height: number };

function measure(view: Pick<View, 'measureInWindow'>): Promise<{ y: number; height: number }> {
  return new Promise((resolve) =>
    view.measureInWindow((_x, y, _width, height) => resolve({ y, height })),
  );
}

export function useTranscriptScroll(
  ready: boolean,
  decisionTarget?: DecisionTarget,
  targetExists = false,
) {
  const scrollRef = useRef<ScrollView>(null);
  const messages = useRef(new Map<string, View>());
  const target = useRef<View | null>(null);
  const follow = useRef(!decisionTarget);
  const offset = useRef(0);
  const anchor = useRef<Position | null>(null);
  const targetLocked = useRef(false);
  const userScroll = useRef(false);
  const generation = useRef(0);
  const restoration = useRef({ running: false, next: null as (() => Promise<void>) | null });
  const [showLatest, setShowLatest] = useState(false);
  function invalidateMeasurements() {
    generation.current++;
    restoration.current.next = null;
    restoration.current = { running: false, next: null };
  }
  useEffect(() => invalidateMeasurements, []);
  function scrollTo(y: number) {
    offset.current = Math.max(0, y);
    scrollRef.current?.scrollTo({ y: offset.current, animated: false });
  }
  function latest() {
    invalidateMeasurements();
    anchor.current = null;
    targetLocked.current = true;
    follow.current = true;
    userScroll.current = false;
    setShowLatest(false);
    scrollRef.current?.scrollToEnd({ animated: false });
  }
  async function captureHistory() {
    invalidateMeasurements();
    const capturedGeneration = generation.current;
    follow.current = false;
    anchor.current = null;
    const host = scrollRef.current?.getNativeScrollRef();
    if (!host) return;
    const viewport = await measure(host);
    if (generation.current !== capturedGeneration) return;
    const positions = await Promise.all(
      [...messages.current].map(async ([id, view]) => ({ id, ...(await measure(view)) })),
    );
    if (generation.current === capturedGeneration)
      anchor.current =
        positions
          .filter((position) => position.y + position.height > viewport.y)
          .sort((a, b) => a.y - b.y)[0] ?? null;
  }
  // Reason: Anchor, decision and follow corrections share one tick-ordered measurement pass.
  // fallow-ignore-next-line complexity
  async function measurePosition() {
    const capturedGeneration = generation.current;
    const saved = anchor.current;
    const view = saved && messages.current.get(saved.id);
    const host = scrollRef.current?.getNativeScrollRef();
    if (saved && view) {
      const current = await measure(view);
      if (generation.current === capturedGeneration && anchor.current === saved)
        scrollTo(offset.current + current.y - saved.y);
    } else if (target.current && targetExists && !targetLocked.current && host) {
      const [position, viewport] = await Promise.all([measure(target.current), measure(host)]);
      if (generation.current === capturedGeneration && !targetLocked.current)
        scrollTo(offset.current + position.y - viewport.y - 12);
    } else if (follow.current && ready) scrollRef.current?.scrollToEnd({ animated: false });
  }
  async function restorePosition() {
    // Native measurements finish asynchronously. Coalesce layout notifications so the next
    // measurement observes the previous correction instead of applying its delta twice.
    const queue = restoration.current;
    queue.next = measurePosition;
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.next) {
        const next = queue.next;
        queue.next = null;
        await next();
      }
    } finally {
      queue.running = false;
    }
  }
  function interacting() {
    invalidateMeasurements();
    userScroll.current = true;
    targetLocked.current = true;
    anchor.current = null;
  }
  const scrollProps: ScrollViewProps = {
    testID: 'chat-transcript',
    scrollEventThrottle: 16,
    onScrollBeginDrag: interacting,
    onPointerDown: interacting,
    onTouchStart: interacting,
    onScroll: ({ nativeEvent }) => {
      offset.current = nativeEvent.contentOffset.y;
      const nearBottom =
        nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - offset.current < 96;
      // Native Markdown measures asynchronously. A layout-induced scroll is not an instruction
      // to stop following; only a reader's touch/drag changes that intent.
      if (userScroll.current) {
        follow.current = nearBottom && (!targetExists || targetLocked.current);
        setShowLatest(!nearBottom);
      }
    },
    onContentSizeChange: () => {
      void restorePosition();
    },
  };
  function registerMessage(id: string, view: View | null) {
    if (view) messages.current.set(id, view);
    else messages.current.delete(id);
  }
  function registerDecision(type: DecisionTarget['type'], id: string, view: View | null) {
    if (decisionTarget?.type === type && decisionTarget.id === id) target.current = view;
  }
  function reset() {
    invalidateMeasurements();
    anchor.current = null;
    target.current = null;
    targetLocked.current = true;
    follow.current = true;
    messages.current.clear();
    userScroll.current = false;
    setShowLatest(false);
  }
  return {
    scrollRef,
    scrollProps,
    showLatest,
    latest,
    captureHistory,
    registerMessage,
    registerDecision,
    restorePosition,
    reset,
  };
}
