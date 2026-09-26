import { matchesToolDenialKeyword } from '@/lib/agent-chat/tool-denial/keywords';
import type { MessagePart } from '../stores/message-store';
import { getOutputNumber } from './agent-tool-utils';

/**
 * Determine if a bash tool part represents a permission denial (Blocked) vs a run failure (Failed).
 * When exitCode is present the command ran, so never treat as Blocked (even if payload is mixed).
 * Otherwise prefer explicit output.permissionDenied; legacy: keyword match only when state is
 * output-error (see the two-tier contract in lib/agent-chat/tool-denial/keywords.ts).
 */
export function getBashToolDenialState(part: MessagePart): {
  permissionDenied: boolean;
  denialReason: string;
} {
  const output = part.output as Record<string, unknown> | undefined;
  const exitCode = getOutputNumber(output, 'exitCode', 'exit_code');

  if (exitCode !== undefined) {
    return { permissionDenied: false, denialReason: '' };
  }
  const explicitDenied = output && output.permissionDenied === true;
  if (explicitDenied) {
    const reason =
      part.errorText || (typeof output?.error === 'string' ? (output.error as string) : '');
    return { permissionDenied: true, denialReason: reason };
  }
  const legacyKeywordDenied =
    part.state === 'output-error' && !!part.errorText && matchesToolDenialKeyword(part.errorText);
  // Only errorText can be the reason here: the legacy path is gated on it being present.
  return { permissionDenied: legacyKeywordDenied, denialReason: part.errorText ?? '' };
}
