import type { ClaudeTurnContext } from '../../claude-turn-context';

/** Make `turn` the one a live session acts for: its callbacks read it, its Stop hook starts a fresh
 * budget, and its MCP channel resolves to the turn's execute. Synchronous, run next to the push. */
export function attachTurn(
  session: { currentTurn: ClaudeTurnContext | null; readonly stopHook?: { reset(): void } | null },
  turn: ClaudeTurnContext,
  bindChannel?: () => void,
): void {
  session.currentTurn = turn;
  session.stopHook?.reset();
  bindChannel?.();
}
