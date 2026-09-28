import { type ReactElement, useCallback } from 'react';
import { toast } from 'sonner';
import {
  agentProseCharsLeft,
  agentProseEditRejection,
  MAX_AGENT_PROSE_LENGTH,
} from '../../../../../../../shared/lib/flows/agent-prose-limit';

export const INSTRUCTIONS_COUNT_ID = 'flow-agent-instructions-count';

/** Every instructions write (typing, paste, command, template) checks the shared prose cap (sc-3166). */
export function useCappedInstructionsPatch(
  instructions: string,
  onConfigPatch: (config: Record<string, unknown>) => void,
): (next: string, instructionsCommandName: string) => boolean {
  return useCallback(
    (next, instructionsCommandName) => {
      const rejection = agentProseEditRejection(instructions, next);
      if (rejection) {
        toast.error(`Not applied: ${rejection}.`);
        return false;
      }
      onConfigPatch({ instructions: next, instructionsCommandName });
      return true;
    },
    [instructions, onConfigPatch],
  );
}

/** Near-cap counter; the editor shows only warnings[0], so the limit is surfaced here. */
export function InstructionsLengthCounter({
  instructions,
}: {
  instructions: string;
}): ReactElement | null {
  const charsLeft = agentProseCharsLeft(instructions.trim().length);
  if (charsLeft === undefined) return null;
  return (
    <p id={INSTRUCTIONS_COUNT_ID} className="text-xs text-warning">
      {charsLeft.toLocaleString()} chars left — agent instructions are limited to{' '}
      {MAX_AGENT_PROSE_LENGTH.toLocaleString()} characters
    </p>
  );
}
