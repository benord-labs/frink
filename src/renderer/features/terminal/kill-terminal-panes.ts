import type { TerminalInstance } from './types';

type KillMutationAsync = (input: { paneId: string }) => Promise<unknown>;

/**
 * Kills PTYs for the given terminal ids in order. Continues after individual failures
 * so callers can reconcile partial success against UI state.
 */
export async function killTerminalPanesByIds(
  mutateAsync: KillMutationAsync,
  terminals: TerminalInstance[],
  idsInOrder: string[],
): Promise<{ succeededIds: string[]; errors: string[] }> {
  const succeededIds: string[] = [];
  const errors: string[] = [];
  const terminalById = new Map(terminals.map((t) => [t.id, t]));
  for (const tid of idsInOrder) {
    const terminal = terminalById.get(tid);
    if (!terminal) continue;
    try {
      await mutateAsync({ paneId: terminal.paneId });
      succeededIds.push(tid);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { succeededIds, errors };
}
