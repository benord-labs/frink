// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, waitFor } from '@testing-library/react';
import { Provider, useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  getDefaultGridRatios,
  getDefaultLayout,
  getDefaultRatios,
  selectedAgentChatIdAtom,
  splitViewAtom,
} from '../atoms';
import { useSplitView } from './use-split-view';

function RemovePaneHarness({
  onDone,
}: {
  onDone: (value: { selectedChatId: string | null; splitChatIds: (string | null)[] }) => void;
}) {
  const { removeFromSplit } = useSplitView();
  const split = useAtomValue(splitViewAtom);
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom);
  const setSplit = useSetAtom(splitViewAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);

  useEffect(() => {
    const chatIds = ['chat-a', 'chat-b'];
    setSplit({
      chatIds,
      ratios: getDefaultRatios(chatIds.length),
      activePaneIndex: 0,
      layout: getDefaultLayout(chatIds.length),
    });
    setSelectedChatId('chat-a');
  }, [setSplit, setSelectedChatId]);

  useEffect(() => {
    if (split.chatIds.length === 2) {
      removeFromSplit('chat-a', 0);
    }
  }, [split.chatIds.length, removeFromSplit]);

  useEffect(() => {
    if (split.chatIds.length === 0) {
      onDone({ selectedChatId, splitChatIds: split.chatIds });
    }
  }, [split.chatIds, selectedChatId, onDone]);

  return null;
}

function CloseSplitHarness({
  onDone,
}: {
  onDone: (value: { selectedChatId: string | null; splitChatIds: (string | null)[] }) => void;
}) {
  const { closeSplit } = useSplitView();
  const split = useAtomValue(splitViewAtom);
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom);
  const setSplit = useSetAtom(splitViewAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);

  useEffect(() => {
    const chatIds = ['chat-a', 'chat-b', 'chat-c'];
    setSplit({
      chatIds,
      ratios: getDefaultRatios(chatIds.length),
      activePaneIndex: 2,
      layout: getDefaultLayout(chatIds.length),
    });
    setSelectedChatId('chat-a');
  }, [setSplit, setSelectedChatId]);

  useEffect(() => {
    if (split.chatIds.length === 3) {
      closeSplit();
    }
  }, [split.chatIds.length, closeSplit]);

  useEffect(() => {
    if (split.chatIds.length === 0) {
      onDone({ selectedChatId, splitChatIds: split.chatIds });
    }
  }, [split.chatIds, selectedChatId, onDone]);

  return null;
}

/** Removing a pane 4→3: `grid` is invalid for three panes → `three-bottom`. */
function ShrinkFourGridToThreeHarness({
  onDone,
}: {
  onDone: (value: { paneCount: number; layout: string }) => void;
}) {
  const { removeFromSplit } = useSplitView();
  const split = useAtomValue(splitViewAtom);
  const setSplit = useSetAtom(splitViewAtom);

  useEffect(() => {
    setSplit({
      chatIds: ['chat-a', 'chat-b', 'chat-c', 'chat-d'],
      ratios: getDefaultRatios(4),
      activePaneIndex: 0,
      layout: 'grid',
      gridRatios: getDefaultGridRatios(),
    });
  }, [setSplit]);

  useEffect(() => {
    if (split.chatIds.length === 4) {
      removeFromSplit('chat-d', 3);
    }
  }, [split.chatIds.length, removeFromSplit]);

  useEffect(() => {
    if (split.chatIds.length === 3) {
      onDone({ paneCount: split.chatIds.length, layout: split.layout });
    }
  }, [split.chatIds.length, split.layout, onDone]);

  return null;
}

/** Removing a pane 3→2: `three-bottom` is invalid for two panes → `horizontal`. */
function ShrinkThreeBottomToTwoHarness({
  onDone,
}: {
  onDone: (value: { paneCount: number; layout: string }) => void;
}) {
  const { removeFromSplit } = useSplitView();
  const split = useAtomValue(splitViewAtom);
  const setSplit = useSetAtom(splitViewAtom);

  useEffect(() => {
    setSplit({
      chatIds: ['chat-a', 'chat-b', 'chat-c'],
      ratios: getDefaultRatios(3),
      activePaneIndex: 0,
      layout: 'three-bottom',
    });
  }, [setSplit]);

  useEffect(() => {
    if (split.chatIds.length === 3) {
      removeFromSplit('chat-c', 2);
    }
  }, [split.chatIds.length, removeFromSplit]);

  useEffect(() => {
    if (split.chatIds.length === 2) {
      onDone({ paneCount: split.chatIds.length, layout: split.layout });
    }
  }, [split.chatIds.length, split.layout, onDone]);

  return null;
}

describe('useSplitView', () => {
  it('keeps the remaining real chat selected when collapsing 2 panes to single view', async () => {
    const onDone = vi.fn();

    render(
      <Provider>
        <RemovePaneHarness onDone={onDone} />
      </Provider>,
    );

    await waitFor(() => {
      const latestCall = onDone.mock.calls[onDone.mock.calls.length - 1]?.[0] as
        | { selectedChatId: string | null; splitChatIds: (string | null)[] }
        | undefined;
      expect(latestCall).toEqual({
        selectedChatId: 'chat-b',
        splitChatIds: [],
      });
    });
  });

  it('restores the focused pane chat when closing split view', async () => {
    const onDone = vi.fn();

    render(
      <Provider>
        <CloseSplitHarness onDone={onDone} />
      </Provider>,
    );

    await waitFor(() => {
      const latestCall = onDone.mock.calls[onDone.mock.calls.length - 1]?.[0] as
        | { selectedChatId: string | null; splitChatIds: (string | null)[] }
        | undefined;
      expect(latestCall).toEqual({
        selectedChatId: 'chat-c',
        splitChatIds: [],
      });
    });
  });

  it('remaps layout from grid to three-bottom when removing a pane (4→3)', async () => {
    const onDone = vi.fn();

    render(
      <Provider>
        <ShrinkFourGridToThreeHarness onDone={onDone} />
      </Provider>,
    );

    await waitFor(() => {
      const latestCall = onDone.mock.calls[onDone.mock.calls.length - 1]?.[0] as
        | { paneCount: number; layout: string }
        | undefined;
      expect(latestCall).toEqual({
        paneCount: 3,
        layout: 'three-bottom',
      });
    });
  });

  it('remaps layout from three-bottom to horizontal when removing a pane (3→2)', async () => {
    const onDone = vi.fn();

    render(
      <Provider>
        <ShrinkThreeBottomToTwoHarness onDone={onDone} />
      </Provider>,
    );

    await waitFor(() => {
      const latestCall = onDone.mock.calls[onDone.mock.calls.length - 1]?.[0] as
        | { paneCount: number; layout: string }
        | undefined;
      expect(latestCall).toEqual({
        paneCount: 2,
        layout: 'horizontal',
      });
    });
  });
});
