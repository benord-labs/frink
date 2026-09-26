import { shellEscapePaths } from './utils';

export type CwdSwitchDecision = 'ignore' | 'auto' | 'prompt';

export type CwdSwitchDecisionInput = {
  nextCwd: string | null | undefined;
  requestedCwd: string | null | undefined;
  dismissedCwd: string | null | undefined;
  currentTerminalCwd: string | null | undefined;
  hasUserInteracted: boolean;
  hasPendingInput: boolean;
};

export function getCwdSwitchDecision(input: CwdSwitchDecisionInput): CwdSwitchDecision {
  const {
    nextCwd,
    requestedCwd,
    dismissedCwd,
    currentTerminalCwd,
    hasUserInteracted,
    hasPendingInput,
  } = input;

  if (!nextCwd) return 'ignore';
  if (nextCwd === requestedCwd) return 'ignore';
  if (nextCwd === dismissedCwd) return 'ignore';
  if (nextCwd === currentTerminalCwd) return 'ignore';

  const isPristine = !hasUserInteracted && !hasPendingInput;
  return isPristine ? 'auto' : 'prompt';
}

export function buildCdCommand(nextCwd: string): string {
  const escapedPath = shellEscapePaths([nextCwd]);
  return `cd ${escapedPath}\n`;
}

export function resolveExternalTerminalPath(
  primaryPath: string | null | undefined,
  fallbackPath: string | null | undefined,
): string | null {
  return primaryPath || fallbackPath || null;
}
