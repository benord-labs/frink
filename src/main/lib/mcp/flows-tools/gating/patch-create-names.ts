/** Per-session names created by frink_flows_patch, so a resent create cannot duplicate a flow. */
// A null flowId marks a create still in flight.
const createdFlowNames = new Map<string, Map<string, string | null>>();

function normaliseFlowName(name: string): string {
  return name.trim().toLowerCase();
}

export type CreatedFlowName = { pending: true } | { pending: false; flowId: string };

export function lookupCreatedFlowName(
  executionId: string,
  name: string,
): CreatedFlowName | undefined {
  const names = createdFlowNames.get(executionId);
  const key = normaliseFlowName(name);
  if (!names?.has(key)) return undefined;
  const flowId = names.get(key);
  return flowId ? { pending: false, flowId } : { pending: true };
}

function setCreatedFlowName(executionId: string, name: string, flowId: string | null): void {
  const names = createdFlowNames.get(executionId) ?? new Map<string, string | null>();
  names.set(normaliseFlowName(name), flowId);
  createdFlowNames.set(executionId, names);
}

function rejectionFor(name: string, existing: CreatedFlowName): string {
  return existing.pending
    ? `A flow named "${name}" is already being created in this chat. Check frink_flows_list before retrying; do not create it again.`
    : `A flow named "${name}" was already created in this chat (flowId: ${existing.flowId}) and is saved. Do not create it again: read it with frink_flows_get and patch it via flowId. Use a different name only if a second flow is really wanted.`;
}

/**
 * Reserve `name` for a create in this session, or return why it is refused. A recorded flow
 * that no longer exists (deleted by the user) frees its name.
 */
export async function claimCreatedFlowName(
  executionId: string,
  name: string,
  flowExists: (flowId: string) => Promise<boolean>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const recorded = lookupCreatedFlowName(executionId, name);
  if (recorded && !recorded.pending && !(await flowExists(recorded.flowId))) {
    const current = lookupCreatedFlowName(executionId, name);
    if (current && !current.pending && current.flowId === recorded.flowId) {
      releaseCreatedFlowName(executionId, name);
    }
  }
  // Re-read after the await: a parallel call may have claimed the name meanwhile.
  const existing = lookupCreatedFlowName(executionId, name);
  if (existing) return { ok: false, message: rejectionFor(name, existing) };
  setCreatedFlowName(executionId, name, null);
  return { ok: true };
}

export function recordCreatedFlowId(executionId: string, name: string, flowId: string): void {
  setCreatedFlowName(executionId, name, flowId);
}

export function releaseCreatedFlowName(executionId: string, name: string): void {
  const names = createdFlowNames.get(executionId);
  if (!names) return;
  names.delete(normaliseFlowName(name));
  if (names.size === 0) createdFlowNames.delete(executionId);
}

/** Free a claimed name unless its flow was saved; a saved flow keeps blocking repeat creates. */
export function releaseUnsavedFlowName(
  executionId: string,
  name: string | null,
  saved: boolean,
): void {
  if (name !== null && !saved) releaseCreatedFlowName(executionId, name);
}

export function resetCreatedFlowNames(executionId?: string): void {
  if (executionId === undefined) {
    createdFlowNames.clear();
    return;
  }
  createdFlowNames.delete(executionId);
}
