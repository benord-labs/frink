import { expect, it, vi } from 'vitest';
vi.mock('./relay/client', () => ({ relayRequest: vi.fn(), closeMobileRelay: vi.fn() }));
import type { Connection } from './api';
import { NO_COMPUTERS, addComputer, removeComputer, selectComputer } from './computers';
import { computerSaver, readComputers, saveComputers, type KeyValue } from './computer-store';

const computer = (n: number): Connection => ({
  relay: 'https://relay.example.test',
  route: String(n).repeat(64),
  key: String(n).repeat(43),
  token: 't'.repeat(43),
  deviceId: `00000000-0000-4000-8000-00000000000${n}`,
  machineName: `Mac ${n}`,
  pairedAt: n,
});

/** An in-memory store whose writes can be made to fail part-way, like an interrupted save. */
function memory() {
  const values = new Map<string, string>();
  let budget = Infinity;
  const write = () => {
    if (budget-- <= 0) throw new Error('interrupted');
  };
  const store: KeyValue = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      write();
      values.set(key, value);
    },
    remove: async (key) => {
      write();
      values.delete(key);
    },
  };
  return { store, values, interruptAfter: (writes: number) => (budget = writes) };
}

/** True when every computer the stored index names has its own stored entry. */
function indexIsBacked(values: Map<string, string>) {
  const { ids } = JSON.parse(values.get('frink.mobile.computers.v2') ?? '{"ids":[]}');
  return (ids as string[]).every((id) => values.has(`frink.mobile.computer.${id}`));
}

it('round-trips several computers and the selected one', async () => {
  const { store } = memory();
  const state = addComputer(addComputer(NO_COMPUTERS, computer(1)), computer(2));
  await saveComputers(store, NO_COMPUTERS, state);
  expect(await readComputers(store)).toEqual(state);
});

it('drops an unreadable entry and selects a computer that is still stored', async () => {
  const { store, values } = memory();
  const state = addComputer(addComputer(NO_COMPUTERS, computer(1)), computer(2));
  await saveComputers(store, NO_COMPUTERS, state);
  values.set(`frink.mobile.computer.${computer(2).deviceId}`, '{not json');
  expect(await readComputers(store)).toEqual({
    computers: [computer(1)],
    selected: computer(1).deviceId,
  });
});

it('an interrupted add or forget never leaves the index naming a missing computer', async () => {
  const one = addComputer(NO_COMPUTERS, computer(1));
  const two = addComputer(one, computer(2));
  for (let writes = 0; writes < 3; writes++) {
    const added = memory();
    await saveComputers(added.store, NO_COMPUTERS, one);
    added.interruptAfter(writes);
    await saveComputers(added.store, one, two).catch(() => {});
    expect(indexIsBacked(added.values)).toBe(true);

    const forgotten = memory();
    await saveComputers(forgotten.store, NO_COMPUTERS, two);
    forgotten.interruptAfter(writes);
    await saveComputers(forgotten.store, two, removeComputer(two, computer(2).deviceId)).catch(
      () => {},
    );
    expect(indexIsBacked(forgotten.values)).toBe(true);
  }
});

it('a failed save is retried by the next one instead of being taken as stored', async () => {
  const { store, values, interruptAfter } = memory();
  const saver = computerSaver(store, NO_COMPUTERS);
  const one = addComputer(NO_COMPUTERS, computer(1));
  interruptAfter(0);
  await expect(saver.save(one)).rejects.toThrow('interrupted');
  expect(saver.stored()).toEqual(NO_COMPUTERS);
  interruptAfter(Infinity);
  const two = addComputer(one, computer(2));
  await saver.save(two);
  expect(indexIsBacked(values)).toBe(true);
  expect(await readComputers(store)).toEqual(two);
});

it('after queued forgets fail part-way, the next save from the stored state stays consistent', async () => {
  const { store, values, interruptAfter } = memory();
  const all = addComputer(addComputer(addComputer(NO_COMPUTERS, computer(1)), computer(2)), computer(3));
  const saver = computerSaver(store, NO_COMPUTERS);
  await saver.save(all);
  // Each forget writes the kept entries and the index, then fails while deleting.
  interruptAfter(3);
  const first = saver.save(removeComputer(all, computer(1).deviceId)).catch(() => {});
  await first;
  interruptAfter(2);
  await saver.save(removeComputer(removeComputer(all, computer(1).deviceId), computer(2).deviceId)).catch(
    () => {},
  );
  interruptAfter(Infinity);
  await saver.save(selectComputer(saver.stored(), computer(1).deviceId));
  expect(indexIsBacked(values)).toBe(true);
});

it('a deferred save stores the state current when its turn comes', async () => {
  const { store } = memory();
  const saver = computerSaver(store, NO_COMPUTERS);
  let current = addComputer(NO_COMPUTERS, computer(1));
  const first = saver.save(current);
  const retry = saver.save(() => current);
  current = NO_COMPUTERS;
  await first;
  await retry;
  expect(await readComputers(store)).toEqual(NO_COMPUTERS);
});
