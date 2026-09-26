import type { ExtractorContext, PayloadExtractor, WebhookEventData } from './types';

type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  teamId?: string;
  assigneeId?: string | null;
  stateId?: string;
  priorityLabel?: string;
  labelIds?: string[];
};

type LinearComment = {
  id?: string;
  body?: string;
  issueId?: string;
  userId?: string;
};

type LinearEventPayload = {
  action?: string;
  type?: string;
  url?: string;
  organizationId?: string;
  actor?: { id?: string };
  data?: LinearIssue & LinearComment;
  /**
   * Present on `update` only, holding the PREVIOUS value of each changed
   * property. Only the properties Frink classifies on are named; a key being
   * present at all is the signal, so the values may legitimately be null.
   */
  updatedFrom?: { assigneeId?: string | null; stateId?: string | null } | null;
};

/**
 * The body as received from Linear's own delivery: entirely unvalidated, so every field is
 * optional and `null` is admissible. Narrowing happens in linearEvent.
 */
type LinearBody = LinearEventPayload | null | undefined;

/** A property is "changed" when Linear lists it in updatedFrom, even if its previous value was null. */
function changed(event: LinearEventPayload, field: 'assigneeId' | 'stateId'): boolean {
  const from = event.updatedFrom;
  return from !== undefined && from !== null && Object.hasOwn(from, field);
}

function linearEvent(body: LinearBody): LinearEventPayload | null {
  return body instanceof Object ? body : null;
}

function detectEventType(body: LinearBody): string | null {
  const event = linearEvent(body);
  if (!event) return null;

  if (event.type === 'Comment') {
    return event.action === 'create' ? 'issue_commented' : null;
  }
  if (event.type !== 'Issue') return null;
  if (event.action === 'create') return 'issue_created';
  if (event.action !== 'update') return null;

  // One delivery resolves to ONE event, and Linear's "start issue" both moves and
  // assigns, so a single update commonly carries both deltas. Status wins while
  // issue_assigned has no trigger template (sc-2251): resolving to a withheld
  // event would swallow the status change and fire nothing at all. Revisiting this
  // precedence when that template ships is sc-2253.
  if (changed(event, 'stateId')) return 'issue_status_changed';
  // Only an assignee ADD is an assignment; an unassign also carries an assigneeId
  // delta, and firing on it makes every reassign spawn two runs.
  if (changed(event, 'assigneeId') && event.data?.assigneeId != null) {
    return 'issue_assigned';
  }
  return null;
}

async function buildEventData(body: LinearBody, ctx: ExtractorContext): Promise<WebhookEventData> {
  // SAFETY: the caller runs detectEventType first and only proceeds on a
  // non-null result, which is reachable only for a well-formed body.
  const event = linearEvent(body) as LinearEventPayload;
  const data = event.data ?? {};

  // webhook-match.ts indexes event data by this exact key for assignee
  // conditions; any other name is invisible to matching.
  const ownerIds = data.assigneeId != null ? [String(data.assigneeId)] : [];
  const previousAssigneeId = event.updatedFrom?.assigneeId;

  return {
    provider: 'linear',
    eventType: ctx.eventType,
    // The Linear user who caused the delivery, never a credential handle. Nothing matches on it:
    // assignee conditions use owner_ids against the account owner's id, resolved on the machine.
    externalUserId: event.actor?.id ?? '',

    issueId: data.issueId || data.id || null,
    identifier: data.identifier || null,
    title: data.title || null,
    url: event.url || null,
    teamId: data.teamId || null,
    stateId: data.stateId || null,
    priorityLabel: data.priorityLabel || null,
    labelIds: Array.isArray(data.labelIds) ? data.labelIds : [],
    actorId: event.actor?.id || null,
    commentBody: event.type === 'Comment' ? data.body || null : null,
    organizationId: event.organizationId || null,
    previousAssigneeId: previousAssigneeId ?? null,
    owner_ids: ownerIds,
    ownerIds,
  };
}

export const linearExtractor: PayloadExtractor = {
  // SAFETY: every field of LinearBody is optional and it admits null, so this
  // widening claims nothing the value must satisfy.
  detectEventType: (payload) => detectEventType(payload as LinearBody),
  // SAFETY: as above.
  buildEventData: (payload, ctx) => buildEventData(payload as LinearBody, ctx),
};
