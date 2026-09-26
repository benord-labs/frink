/**
 * What a refused flow-tool call tells the user and the agent.
 *
 * Kept together because the two must stay consistent: `permissionDenied` is the
 * flag the agent's guidance keys "do not retry" off, and the summary is the
 * line the user reads. Deriving both from the message here means no call site
 * can pair a decline flag with not-a-decline copy.
 */
import { FLOW_PERMISSION_SUMMARIES } from '../../../../../shared/types/flows/flow-change-presentation';

export const STALE_FLOW_CONTEXT_MESSAGE =
  'The Flow write could not be authorized because its execution context is no longer active. Retry the Flow tool from the current turn.';
export const MISSING_FLOW_PROJECT_MESSAGE =
  'Flow writes require an active project context. Open this chat in a project and retry the Flow tool.';
export const FLOW_CONSENT_DENIED_MESSAGE =
  'The user declined to let this agent run the flow. Do not retry — ask them in chat what they would like changed first.';
/** Flow-driven Auto outcome: the card is up, unanswered, and this run did not start. */
export const FLOW_CONSENT_PENDING_MESSAGE =
  'This flow has no standing agent-run grant, so Frink asked the user to approve it in chat. Nobody has answered yet and this run did not start. Tell the user the approval is waiting; once they allow the flow, a later run will start without asking again.';
/** The batch grew past the size quoted on the card before it was answered. */
export const FLOW_CONSENT_BATCH_CHANGED_MESSAGE =
  'This batch grew after the user was asked to approve it, so it did not start — they approved a smaller batch than the one now staged. Ask them again, stating the new size.';
/** Another concurrent call already spent the one run the user approved. */
export const FLOW_CONSENT_SUPERSEDED_MESSAGE =
  'The user approved a single run of this flow and another call in this turn already used it. Do not retry automatically — ask them before running it again.';
/** The card could not be raised or answered at all — not a decision either way. */
export const FLOW_CONSENT_UNAVAILABLE_MESSAGE =
  'Frink could not ask the user whether this agent may run the flow, so the run did not start. Nobody declined. Report that approval could not be requested and let the user retry.';
/**
 * Deliberately distinct from a denial: nobody refused, the card expired unseen.
 * Telling the agent it was denied would have it report a decision the user
 * never made.
 */
export const FLOW_CONSENT_EXPIRED_MESSAGE =
  'The request to run this flow expired before the user answered — the consent card is no longer showing. Nobody declined. Mention that the approval is still needed and let the user re-trigger it when they are back.';

/**
 * Messages that really do mean "the user said no": an explicit click, or a
 * rule they wrote. Everything else — a stale turn, a missing project, a
 * timeout, an unreachable permission store, a broken auth invariant — is a
 * failure, not a decision, and an allowlist keeps a new failure mode from
 * silently defaulting into "declined".
 */
const USER_DECLINE_MESSAGES = new Set([
  FLOW_CONSENT_DENIED_MESSAGE,
  'User denied permission',
  'User denied the MCP tool call.',
]);

export function isUserDecline(message: string): boolean {
  if (USER_DECLINE_MESSAGES.has(message)) return true;
  // The v2 dispatcher's rule denials — the user wrote the rule, so "do not
  // retry" is the right instruction.
  return message.startsWith('Denied by ');
}

export function flowPermissionSummary(message: string): string {
  if (message === STALE_FLOW_CONTEXT_MESSAGE) return FLOW_PERMISSION_SUMMARIES.staleContext;
  if (message === MISSING_FLOW_PROJECT_MESSAGE) return FLOW_PERMISSION_SUMMARIES.missingProject;
  // The four consent outcomes each have their own copy. Falling through to
  // `blocked` would tell a user their own unanswered card had been blocked.
  if (message === FLOW_CONSENT_DENIED_MESSAGE) return FLOW_PERMISSION_SUMMARIES.denied;
  if (message === FLOW_CONSENT_PENDING_MESSAGE) return FLOW_PERMISSION_SUMMARIES.consentPending;
  if (message === FLOW_CONSENT_EXPIRED_MESSAGE) return FLOW_PERMISSION_SUMMARIES.timedOut;
  if (message === FLOW_CONSENT_UNAVAILABLE_MESSAGE) {
    return FLOW_PERMISSION_SUMMARIES.consentUnavailable;
  }
  if (message === FLOW_CONSENT_BATCH_CHANGED_MESSAGE) {
    return FLOW_PERMISSION_SUMMARIES.consentBatchChanged;
  }
  // Not a denial: the user approved, and a sibling call already spent the run.
  if (message === FLOW_CONSENT_SUPERSEDED_MESSAGE) {
    return FLOW_PERMISSION_SUMMARIES.consentSuperseded;
  }
  if (message.toLowerCase().includes('timed out')) return FLOW_PERMISSION_SUMMARIES.timedOut;
  if (message === 'User denied permission' || message === 'User denied the MCP tool call.') {
    return FLOW_PERMISSION_SUMMARIES.denied;
  }
  return FLOW_PERMISSION_SUMMARIES.blocked;
}
