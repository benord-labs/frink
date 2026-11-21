import { describe, expect, it } from 'vitest';
import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { createFlowActions, flowSheet } from './flow-actions';

const FLOW: MobileFlow = {
  id: 'flow-1',
  name: 'Digest',
  description: '',
  enabled: true,
  trigger: 'manual_trigger',
  latestRunId: null,
  status: null,
  lastRun: null,
};

type Prompted = { title: string; message: string; retry: () => void };
type Sent =
  | { type: 'startFlow'; id: string; requestId: string }
  | { type: 'setFlowEnabled'; id: string; enabled: boolean };

/** A computer that refuses the first `refusals` requests, then starts run-1. */
function harness(refusals = 0) {
  const sent: Sent[] = [];
  const prompts: Prompted[] = [];
  let left = refusals;
  let ids = 0;
  let release = () => {};
  const gate = { held: false };
  async function answer(input: Sent) {
    sent.push(input);
    if (gate.held) await new Promise<void>((resolve) => (release = resolve));
    if (left-- > 0) throw new Error('Open Frink on your computer to run Flows.');
  }
  const actions = createFlowActions(
    {
      start: async (id, requestId) => {
        await answer({ type: 'startFlow', id, requestId });
        return { id: 'run-1' };
      },
      setEnabled: async (id, enabled) => {
        await answer({ type: 'setFlowEnabled', id, enabled });
        return { ok: true };
      },
    },
    (title, message, retry) => prompts.push({ title, message, retry }),
    () => `id-${++ids}`,
  );
  return { actions, sent, prompts, gate, release: () => release() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createFlowActions', () => {
  it('starts once per tap with its own request id', async () => {
    const { actions, sent } = harness();
    const started: string[] = [];
    await actions.start(FLOW, (id) => started.push(id));
    await actions.start(FLOW, (id) => started.push(id));
    expect(sent).toEqual([
      { type: 'startFlow', id: 'flow-1', requestId: 'id-1' },
      { type: 'startFlow', id: 'flow-1', requestId: 'id-2' },
    ]);
    expect(started).toEqual(['run-1', 'run-1']);
  });

  it('ignores a second tap while the first is still on its way', async () => {
    const { actions, sent, gate, release } = harness();
    gate.held = true;
    const first = actions.start(FLOW, () => {});
    await actions.start(FLOW, () => {});
    release();
    await first;
    expect(sent).toHaveLength(1);
  });

  it('explains a refusal and retries with the same request id', async () => {
    const { actions, sent, prompts } = harness(1);
    const started: string[] = [];
    await actions.start(FLOW, (id) => started.push(id));
    expect(started).toEqual([]);
    expect(prompts).toMatchObject([
      { title: 'Couldn’t start Digest', message: 'Open Frink on your computer to run Flows.' },
    ]);
    prompts[0].retry();
    await settle();
    expect(sent.map((input) => input.type === 'startFlow' && input.requestId)).toEqual([
      'id-1',
      'id-1',
    ]);
    expect(started).toEqual(['run-1']);
  });

  it('turns a Flow on or off and reports when it could not', async () => {
    const { actions, sent, prompts } = harness(1);
    let done = 0;
    await actions.setEnabled(FLOW, false, () => done++);
    expect(prompts[0].title).toBe('Couldn’t turn Digest off');
    await actions.setEnabled(FLOW, false, () => done++);
    expect(sent.at(-1)).toEqual({ type: 'setFlowEnabled', id: 'flow-1', enabled: false });
    expect(done).toBe(1);
  });
});

describe('flowSheet', () => {
  function sheetFor(flow: MobileFlow) {
    const { actions, sent } = harness();
    const opened: string[] = [];
    let refreshed = 0;
    const sheet = flowSheet(flow, actions, {
      openRun: (id) => opened.push(id),
      refresh: () => refreshed++,
    });
    return { sheet, sent, opened, refreshed: () => refreshed };
  }

  it('lists the Flow’s actions with Cancel last, and Cancel does nothing', async () => {
    const { sheet, sent, opened } = sheetFor(FLOW);
    expect(sheet.options).toEqual(['Run now', 'Turn off', 'Cancel']);
    expect(sheet.cancelButtonIndex).toBe(2);
    sheet.pick(2);
    await settle();
    expect(sent).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('Run now starts one run, refreshes the list and opens the run', async () => {
    const { sheet, sent, opened, refreshed } = sheetFor(FLOW);
    sheet.pick(0);
    await settle();
    expect(sent).toEqual([{ type: 'startFlow', id: 'flow-1', requestId: 'id-1' }]);
    expect(opened).toEqual(['run-1']);
    expect(refreshed()).toBe(1);
  });

  it('turns the Flow the other way and refreshes so its row dims', async () => {
    const { sheet, sent, refreshed } = sheetFor(FLOW);
    sheet.pick(1);
    await settle();
    expect(sent).toEqual([{ type: 'setFlowEnabled', id: 'flow-1', enabled: false }]);
    expect(refreshed()).toBe(1);
  });

  it('opens the last run without sending anything', () => {
    const ran = {
      ...FLOW,
      lastRun: { id: 'run-9', status: 'completed', at: '2026-09-29T14:00:00Z' },
    };
    const { sheet, sent, opened } = sheetFor(ran);
    sheet.pick(sheet.options.indexOf('View last run'));
    expect(opened).toEqual(['run-9']);
    expect(sent).toEqual([]);
  });
});
