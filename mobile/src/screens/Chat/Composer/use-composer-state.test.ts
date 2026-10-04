import { expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
// Plain stand-ins: the queue lives in a ref, so one call of the hook is enough to drive it.
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock('../../../lib/connection', () => ({
  useConnection: () => ({ request }),
  useResource: () => ({ data: { mode: 'agent', settings: {} }, refresh: vi.fn(), updatedAt: 0 }),
}));

import { useComposerState } from './use-composer-state';

it('waits for a change made while an earlier one is still being answered', async () => {
  const answers: (() => void)[] = [];
  request.mockImplementation(() => new Promise<void>((resolve) => answers.push(resolve)));
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React is replaced by the stand-ins above.
  const state = useComposerState('chat-1', 'sub-1');
  let done = false;
  state.change({ type: 'setMode', mode: 'plan' });
  void state.settled().then(() => (done = true));
  state.change({ type: 'setMode', mode: 'agent' });

  await vi.waitFor(() => expect(answers).toHaveLength(1));
  answers[0]();
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  expect(done).toBe(false);
  answers[1]();
  await vi.waitFor(() => expect(done).toBe(true));
});
