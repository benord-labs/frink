import { matchesToolDenialKeyword } from '@/lib/agent-chat/tool-denial/keywords';
import type { MessagePart } from '../stores/message-store';

/**
 * Determine if an edit-family tool part represents a permission denial (Blocked) vs a genuine
 * failure (Failed). Prefers the explicit output.permissionDenied flag and the readonly_mode code;
 * legacy: keyword match on either error field (see the two-tier contract in
 * lib/agent-chat/tool-denial/keywords.ts).
 */
export function getEditToolDenialState(part: MessagePart): {
  permissionDenied: boolean;
  denialReason: string;
} {
  const errorText = part.errorText ?? '';
  const output = (part.output ?? {}) as Record<string, unknown>;
  const outputError = typeof output.error === 'string' ? output.error : '';
  const outputCode = typeof output.code === 'string' ? output.code : '';

  const hasDeniedText =
    matchesToolDenialKeyword(errorText) || matchesToolDenialKeyword(outputError);
  const permissionDenied =
    output.permissionDenied === true || outputCode === 'readonly_mode' || hasDeniedText;
  const denialReason = errorText || outputError;

  return { permissionDenied, denialReason };
}
