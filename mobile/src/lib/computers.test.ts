import { expect, it } from 'vitest';
import type { Connection } from './api';
import {
  NO_COMPUTERS,
  addComputer,
  namesake,
  pairingOverlap,
  replacedComputer,
  removeComputer,
  selectComputer,
  selectedComputer,
} from './computers';

const computer = (n: number, overrides: Partial<Connection> = {}): Connection => ({
  relay: 'https://relay.example.test',
  route: String(n).repeat(64),
  key: String(n).repeat(43),
  token: 't'.repeat(43),
  deviceId: `00000000-0000-4000-8000-00000000000${n}`,
  machineName: `Mac ${n}`,
  pairedAt: n,
  ...overrides,
});

it('adds computers and shows the newest one', () => {
  const state = addComputer(addComputer(NO_COMPUTERS, computer(1)), computer(2));
  expect(state.computers.map((c) => c.machineName)).toEqual(['Mac 1', 'Mac 2']);
  expect(selectedComputer(state)?.machineName).toBe('Mac 2');
});

it('re-pairing the same desktop replaces its entry instead of adding a second', () => {
  const first = addComputer(NO_COMPUTERS, computer(1));
  const again = computer(1, { deviceId: '00000000-0000-4000-8000-000000000009', pairedAt: 9 });
  const state = addComputer(first, again);
  expect(state.computers).toEqual([again]);
  expect(state.selected).toBe(again.deviceId);
});

it('finds a same-named computer with another pairing, and can replace it explicitly', () => {
  const old = addComputer(NO_COMPUTERS, computer(1));
  const reset = computer(2, { machineName: 'Mac 1' });
  expect(namesake(old.computers, { ...reset, machine: 'Mac 1' })?.deviceId).toBe(
    computer(1).deviceId,
  );
  expect(namesake(old.computers, { ...computer(1), machine: 'Mac 1' })).toBeNull();
  expect(addComputer(old, reset, computer(1).deviceId).computers).toEqual([reset]);
  expect(addComputer(old, reset).computers).toHaveLength(2);
});

it('forgetting the shown computer shows the next one, and the last one leaves none', () => {
  const state = addComputer(addComputer(NO_COMPUTERS, computer(1)), computer(2));
  const next = removeComputer(state, computer(2).deviceId);
  expect(selectedComputer(next)?.machineName).toBe('Mac 1');
  expect(removeComputer(next, computer(1).deviceId)).toEqual(NO_COMPUTERS);
  expect(removeComputer(state, computer(1).deviceId).selected).toBe(computer(2).deviceId);
});

it('selects only a paired computer', () => {
  const state = addComputer(addComputer(NO_COMPUTERS, computer(1)), computer(2));
  expect(selectComputer(state, computer(1).deviceId).selected).toBe(computer(1).deviceId);
  expect(selectComputer(state, 'unknown')).toBe(state);
});

it('says whether a code re-pairs, shares a name with, or adds to the paired computers', () => {
  const paired = addComputer(NO_COMPUTERS, computer(1)).computers;
  expect(pairingOverlap(paired, { ...computer(1), machine: 'Mac 1' })).toEqual({
    kind: 'repair',
    existing: computer(1),
  });
  expect(pairingOverlap(paired, { ...computer(2), machine: 'Mac 1' })).toEqual({
    kind: 'namesake',
    existing: computer(1),
  });
  expect(pairingOverlap(paired, { ...computer(2), machine: 'Mac 2' })).toBeNull();
});

it('a re-pair or a replaced same-named computer names the pairing it supersedes', () => {
  const paired = addComputer(NO_COMPUTERS, computer(1)).computers;
  const repair = pairingOverlap(paired, { ...computer(1), machine: 'Mac 1' });
  const namesake = pairingOverlap(paired, { ...computer(2), machine: 'Mac 1' });
  expect(replacedComputer(repair, false)).toEqual(computer(1));
  expect(replacedComputer(namesake, false)).toEqual(computer(1));
  expect(replacedComputer(namesake, true)).toBeUndefined();
  expect(replacedComputer(null, false)).toBeUndefined();
});
