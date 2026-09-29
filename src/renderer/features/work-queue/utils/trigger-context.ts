import {
  type GmailFullContent,
  isGmailFullContent,
  isTriggerSource,
  isValidTriggerContext,
  type TriggerContext,
  withTriggerContextDefaults,
} from '../../../../shared/types/trigger-context';

export function parseTriggerContext(triggerContext: unknown): TriggerContext | null {
  if (!triggerContext) {
    return null;
  }

  return isValidTriggerContext(triggerContext) ? withTriggerContextDefaults(triggerContext) : null;
}

/**
 * Gmail full content — the rich shape (with body) the email-body dialog renders. Returns null for
 * the slim flow-trigger Gmail shape (no body); the dialog then falls back to the raw payload.
 */
export function asGmailFullContent(
  triggerContext: TriggerContext | null | undefined,
): GmailFullContent | null {
  if (!triggerContext || !isTriggerSource(triggerContext, 'gmail')) {
    return null;
  }
  if (!isGmailFullContent(triggerContext.fullContent)) {
    return null;
  }
  return triggerContext.fullContent;
}
