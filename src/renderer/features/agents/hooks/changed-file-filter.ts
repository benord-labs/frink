import type { MessagePart as StoreMessagePart } from '../stores/message-store';
import { getEditToolDenialState } from '../ui/agent-edit-permission';

type PartialMessagePart = Pick<StoreMessagePart, 'type' | 'state' | 'output' | 'errorText'>;

export function shouldSkipChangedFilePart(part: PartialMessagePart): boolean {
  if (getEditToolDenialState(part as StoreMessagePart).permissionDenied) return true;
  const output = (part.output ?? {}) as Record<string, unknown>;
  if (output.success === false) return true;
  return part.state === 'output-error';
}
