import { expect, vi } from 'vitest';
import { checkPermission } from '../../../permissions/v2/check';
import * as socketClient from '../../client';
import { hasPendingPermissionRequest } from '../../streaming/pending-permission/validate-tool-permission';
import { type Observed, startRow } from './drive';
import { REPLY, SIMPLE_TURN } from './fixtures';
import type { Scenario } from './grid';

type Row = ReturnType<typeof startRow>;
const FIRST = 'echo first';
const SECOND = 'echo second';

/** No rule decides the agent's command, so Frink shows a card and waits for the person. */
function askThePerson(): void {
  vi.mocked(checkPermission).mockResolvedValue({
    decision: 'ask',
    prompt: { tool: 'Bash', input: {}, reason: 'no-matching-rule' },
  });
}

/** Two sub-chats of one chat each ask to run a command at once. */
const twoAsks: Scenario['play'] = async (h, runtime) => {
  askThePerson();
  const [first, second] = [startRow(h, runtime), startRow(h, runtime)];
  const asksOpen = Promise.withResolvers<void>();
  const ended = new Set<Row>();
  const run = (row: Row, ask: string) =>
    row.turn(SIMPLE_TURN[runtime].turn, { ask, asksOpen: asksOpen.promise }).then(() => {
      ended.add(row);
    });
  const started = (row: Row) => () => expect(row.observe().inputs).toHaveLength(1);
  // B starts once A's runtime has, so Claude's CLIs spawn in a known order.
  const turns = [run(first, FIRST)];
  await vi.waitFor(started(first));
  turns.push(run(second, SECOND));
  await vi.waitFor(started(second));
  asksOpen.resolve();
  const cardOf = (row: Row) => row.observe().cards[0];
  await vi.waitFor(() => expect([cardOf(first), cardOf(second)]).not.toContain(undefined));
  // The later ask is answered first, so an answer that reaches the wrong turn shows. Each turn
  // ends before the next answer: vitest delays a second concurrent import of a mocked module.
  const answers: Array<[Row, boolean]> = [
    [second, false],
    [first, true],
  ];
  for (const [row, approved] of answers) {
    const card = cardOf(row);
    if (card) h.clientPermissionBridge.lastResponseHandler?.({ ...card, approved });
    await vi.waitFor(() => expect(ended.has(row)).toBe(true));
  }
  await Promise.all(turns);
  return { ...first.observe(), peer: second.observe() };
};

/** Stop is pressed while the agent's command still waits on its card. */
const stopWhileAsking: Scenario['play'] = async (h, runtime) => {
  askThePerson();
  const row = startRow(h, runtime);
  const turn = row.turn(SIMPLE_TURN[runtime].turn, { ask: FIRST });
  await vi.waitFor(() => expect(row.observe().cards).toHaveLength(1));
  row.stop();
  await vi.waitFor(() => expect(row.observe().inputs[0]?.end.allowed).toBe(false));
  await turn;
  return row.observe();
};

const commandsAsked = (seen?: Observed) => seen?.cards.map((card) => card.path);

export const APPROVAL_SCENARIOS: Scenario[] = [
  {
    id: 'concurrent-approvals',
    play: twoAsks,
    check: ({ peer, ...seen }) => {
      expect([commandsAsked(seen), commandsAsked(peer)]).toEqual([[FIRST], [SECOND]]);
      expect([seen.inputs[0]?.end.allowed, peer?.inputs[0]?.end.allowed]).toEqual([true, false]);
      expect([seen.completed, peer?.completed]).toEqual([true, true]);
      expect(
        [seen.subChatId, peer?.subChatId].map((id) => id && hasPendingPermissionRequest(id)),
      ).toEqual([false, false]);
    },
  },
  {
    id: 'stop-while-asking',
    play: stopWhileAsking,
    precondition: {
      name: 'the command reached a card',
      check: (seen) => expect(commandsAsked(seen)).toEqual([FIRST]),
    },
    check: (seen) => {
      expect(seen.inputs[0]?.end.allowed).toBe(false);
      expect(vi.mocked(socketClient.sendPermissionDismiss)).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: seen.cards[0]?.requestId }),
      );
      expect(hasPendingPermissionRequest(seen.subChatId)).toBe(false);
      expect(seen.chunks).not.toContainEqual(expect.objectContaining({ delta: REPLY }));
    },
  },
];
