import type { SDKMessageOrigin } from '@anthropic-ai/claude-agent-sdk';
import type { AssistantMessageMetadata } from '../../../../shared/types/assistant-message';

/** The message another Claude session sent to start this turn, read off the turn's result: the
 * only frame that says where a turn the CLI started on its own came from. */
export function peerMessageOf(
  origin: SDKMessageOrigin | undefined,
): Pick<AssistantMessageMetadata, 'peerMessage'> {
  if (origin?.kind !== 'peer') return {};
  return { peerMessage: { name: origin.name, body: origin.body } };
}
