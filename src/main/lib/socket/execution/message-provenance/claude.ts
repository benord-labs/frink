import type { SDKUserMessage, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  MESSAGE_PROVENANCE_RULE,
  renderMessageProvenance,
  type MessageProvenance,
} from '../../../../../shared/lib/message-markers/message-provenance';
import { createMessageProvenance } from './index';

/** The turn a delivery was pushed in; entries are compared by identity, never read. */
type DeliveryTurn = { messageProvenance?: MessageProvenance };
type PendingDelivery = { prompt: string; record: MessageProvenance; turn: DeliveryTurn };
type ProvenanceSession = {
  pendingDeliveries: PendingDelivery[];
  /** The session has MESSAGE_PROVENANCE_RULE: in its system prompt, or sent with a record. */
  provenanceRuleKnown?: boolean;
};
const MAX_PENDING_DELIVERIES = 64;

/** The hook has no message id; this correlation is best effort, never authentication. */
export function registerClaudeDelivery(
  session: ProvenanceSession,
  message: SDKUserMessage,
  record: MessageProvenance,
  turn: DeliveryTurn,
): void {
  const content = message.message.content;
  const prompt = Array.isArray(content)
    ? content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
    : content;
  session.pendingDeliveries = session.pendingDeliveries.filter((entry) => entry.turn === turn);
  session.pendingDeliveries.push({ prompt, record, turn });
  if (session.pendingDeliveries.length > MAX_PENDING_DELIVERIES) session.pendingDeliveries.shift();
}

export function consumeClaudeDelivery(
  session: ProvenanceSession,
  input: Pick<UserPromptSubmitHookInput, 'source' | 'prompt'>,
): string {
  if (input.source !== undefined && input.source !== 'sdk') {
    const internal = ['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event'].includes(
      input.source ?? '',
    );
    const record = createMessageProvenance({
      source: internal ? 'internal' : 'unknown',
      kind: internal ? 'wake' : 'message',
    });
    return withRuleOnce(session, renderMessageProvenance(record));
  }
  const matches = session.pendingDeliveries.filter((entry) => entry.prompt === input.prompt);
  const [first] = matches;
  // Matches that say the same thing are interchangeable; only differing ones are ambiguous.
  const agree =
    first !== undefined && matches.every(({ record }) => sameOrigin(record, first.record));
  session.pendingDeliveries = session.pendingDeliveries.filter((entry) =>
    agree ? entry !== first : entry.prompt !== input.prompt,
  );
  return withRuleOnce(
    session,
    renderMessageProvenance(agree ? first.record : createMessageProvenance()),
  );
}

/** A session adopted from before the Flow has no rule in its prompt: define the record once. */
function withRuleOnce(session: ProvenanceSession, record: string): string {
  if (session.provenanceRuleKnown) return record;
  session.provenanceRuleKnown = true;
  return `${MESSAGE_PROVENANCE_RULE}\n${record}`;
}

function sameOrigin(a: MessageProvenance, b: MessageProvenance): boolean {
  return a.source === b.source && a.kind === b.kind;
}

/** Register the turn's record for the hook, then hand the prompt to the CLI. */
export function pushClaudeTurnDelivery(
  session: ProvenanceSession & {
    currentTurn: { messageProvenance?: MessageProvenance } | null;
    queue: { push: (message: SDKUserMessage) => void };
    turnSettled: Promise<void> | null;
  },
  message: SDKUserMessage,
): void {
  const turn = session.currentTurn;
  if (turn?.messageProvenance)
    registerClaudeDelivery(session, message, turn.messageProvenance, turn);
  // Entries die with the busy span, so a later turn or wake burst can never match a stale one.
  void session.turnSettled?.then(() => {
    session.pendingDeliveries = [];
  });
  session.queue.push(message);
}
