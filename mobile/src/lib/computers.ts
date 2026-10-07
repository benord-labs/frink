import type { Connection } from './api';

/** Every computer this iPhone is paired with, and the one the app is showing. */
export type Computers = { computers: Connection[]; selected: string | null };
export const NO_COMPUTERS: Computers = { computers: [], selected: null };

/** The same desktop pairing again: route and pinned key are its identity, not its name. */
export function samePairing(a: Pick<Connection, 'route' | 'key'>, b: Connection) {
  return a.route === b.route && a.key === b.key;
}

export function selectedComputer({ computers, selected }: Computers): Connection | null {
  return computers.find((c) => c.deviceId === selected) ?? null;
}

/** Another paired computer with this name — usually the same Mac after its access was reset. */
export function namesake(
  computers: Connection[],
  pairing: Pick<Connection, 'route' | 'key'> & { machine: string },
) {
  return (
    computers.find((c) => c.machineName === pairing.machine && !samePairing(pairing, c)) ?? null
  );
}

/**
 * How a pairing code relates to the computers already paired: the same pairing again, another
 * pairing under a paired computer's name (usually that computer after its access was reset), or new.
 */
export function pairingOverlap(
  computers: Connection[],
  pairing: (Pick<Connection, 'route' | 'key'> & { machine: string }) | null,
) {
  if (!pairing) return null;
  const same = computers.find((c) => samePairing(pairing, c));
  if (same) return { kind: 'repair' as const, existing: same };
  const existing = namesake(computers, pairing);
  return existing ? { kind: 'namesake' as const, existing } : null;
}

/** The pairing a new one replaces: the same computer's, or a same-named one unless both are kept. */
export function replacedComputer(overlap: ReturnType<typeof pairingOverlap>, keepBoth: boolean) {
  if (overlap?.kind === 'namesake' && keepBoth) return undefined;
  return overlap?.existing;
}

/** Adds and selects a computer; re-pairing replaces its entry, as does an explicitly replaced one. */
export function addComputer(state: Computers, computer: Connection, replacing?: string): Computers {
  const kept = state.computers.filter((c) => !samePairing(computer, c) && c.deviceId !== replacing);
  return { computers: [...kept, computer], selected: computer.deviceId };
}

/** Drops a computer; when it was the one shown, the next remaining computer is shown instead. */
export function removeComputer(state: Computers, deviceId: string): Computers {
  const computers = state.computers.filter((c) => c.deviceId !== deviceId);
  const selected = state.selected === deviceId ? (computers[0]?.deviceId ?? null) : state.selected;
  return { computers, selected };
}

export function selectComputer(state: Computers, deviceId: string): Computers {
  return state.computers.some((c) => c.deviceId === deviceId)
    ? { ...state, selected: deviceId }
    : state;
}
