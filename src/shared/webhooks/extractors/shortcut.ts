import type { ExtractorContext, PayloadExtractor, WebhookEventData } from './types';

type ShortcutAction = {
  action: string;
  entity_type: string;
  changes?: Record<string, { old?: unknown; new?: unknown } | unknown>;
  story_type?: string;
  owner_ids?: string[];
  label_ids?: number[];
  epic_id?: number | null;
};

type ShortcutReference = {
  id: number | string;
  entity_type: string;
  name?: string;
  app_url?: string;
  type?: string;
};

type ShortcutPayload = {
  member_id: string;
  primary_id: number;
  references?: ShortcutReference[];
  actions: ShortcutAction[];
};

function detectEventType(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<ShortcutPayload>;
  const action = p.actions?.[0];
  if (!action) return null;

  if (action.entity_type === 'story') {
    if (action.action === 'create') {
      return 'story_created';
    }
    if (action.action === 'update') {
      const changes = action.changes || {};
      if ('owner_ids' in changes) {
        // Only an owner ADD is an assignment. A reassign reaches us as two
        // deliveries (remove-old, add-new) with distinct payload.ids, so without
        // this gate the remove half mis-fires a second `story_assigned` run.
        const oc = changes.owner_ids as { adds?: unknown[]; old?: unknown[]; new?: unknown[] };
        const adds = Array.isArray(oc?.adds) ? oc.adds : [];
        const next = Array.isArray(oc?.new) ? oc.new : null;
        const prev = Array.isArray(oc?.old) ? oc.old : [];
        const added = next ? next.some((o) => !prev.includes(o)) : adds.length > 0;
        if (added) {
          return 'story_assigned';
        }
        // removal-only — not an assignment; fall through (no event).
      }
      if ('workflow_state_id' in changes) {
        return 'story_moved';
      }
    }
  }

  return null;
}

async function buildEventData(payload: unknown, ctx: ExtractorContext): Promise<WebhookEventData> {
  const p = payload as ShortcutPayload;
  const references = p.references || [];
  const story = references.find((r) => r.entity_type === 'story');
  const project = references.find((r) => r.entity_type === 'project');
  const action = p.actions?.[0];
  const changes = action?.changes || {};

  const workflowStateChange = changes.workflow_state_id as
    | { old?: number; new?: number }
    | undefined;

  const ownerChange = changes.owner_ids as { adds?: string[]; new?: string[] } | undefined;

  // A create action carries the story's own fields; only an update reports owners as a change.
  const currentOwnerIds = ownerChange?.adds || ownerChange?.new || action?.owner_ids || [];
  // Reference ids arrive as numbers or strings; compare as strings so a label is never dropped.
  const labelIds = new Set((action?.label_ids ?? []).map(String));

  const findStateName = (stateId: number | undefined): string | null => {
    if (!stateId) return null;
    const state = references.find((r) => r.entity_type === 'workflow-state' && r.id === stateId);
    return state?.name || null;
  };

  return {
    provider: 'shortcut',
    eventType: ctx.eventType,
    // Shortcut's externalUserId is the member_id from the webhook payload, NOT ctx.externalUserId.
    // Safe because the handler verifies the Shortcut HMAC signature before calling this extractor,
    // so member_id cannot be forged. If signature verification is ever skipped upstream this
    // becomes an attacker-controlled value flowing into rule matching — keep the HMAC gate.
    externalUserId: p.member_id,

    storyId: p.primary_id,
    storyName: story?.name || null,
    storyUrl: story?.app_url || null,
    // Ids are strings: authored filter values are strings and the matcher compares strictly.
    projectId: project?.id != null ? String(project.id) : null,
    projectName: project?.name || null,
    storyType: action?.story_type || null,
    // Label ids and the epic ride only the create action; references carry the label names.
    labels: references
      .filter((r) => r.entity_type === 'label' && labelIds.has(String(r.id)))
      .map((r) => r.name ?? ''),
    epicId: action?.epic_id != null ? String(action.epic_id) : null,

    oldStatus: findStateName(workflowStateChange?.old),
    newStatus: findStateName(workflowStateChange?.new),
    old_status: findStateName(workflowStateChange?.old),
    new_status: findStateName(workflowStateChange?.new),

    owner_ids: currentOwnerIds,
    ownerIds: currentOwnerIds,
  };
}

export const shortcutExtractor: PayloadExtractor = {
  detectEventType,
  buildEventData,
};
