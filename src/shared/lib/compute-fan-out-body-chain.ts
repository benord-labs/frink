import type { FlowEdge, FlowNode } from './validate-flow-graph';

export type FanOutBranch = {
  rootNodeId: string;
  tailNodeId: string;
  nodeIds: string[];
};

export type FanOutStructureResolution =
  | {
      ok: true;
      structure: {
        branches: FanOutBranch[];
        bodyNodeIds: string[];
        continuationNodeId: string;
      };
    }
  | { ok: false; incomplete: boolean; message: string };

type FanOutStructureFailure = Extract<FanOutStructureResolution, { ok: false }>;

const failure = (message: string, incomplete = false): FanOutStructureFailure => ({
  ok: false,
  incomplete,
  message,
});

type BranchResolution =
  | { ok: true; branch: FanOutBranch; continuationNodeId: string }
  | FanOutStructureFailure;

type BranchStep =
  | { ok: true; nextMemberId: string }
  | { ok: true; continuationNodeId: string }
  | FanOutStructureFailure;

function resolveBranchStep(
  currentId: string,
  memberIds: ReadonlySet<string>,
  edges: FlowEdge[],
): BranchStep {
  const outgoing = edges.filter((edge) => edge.source === currentId);
  const internal = outgoing.filter((edge) => memberIds.has(edge.target));
  const external = outgoing.filter((edge) => !memberIds.has(edge.target));
  if (internal.length > 1 || (internal.length === 1 && external.length > 0)) {
    return failure(`body member "${currentId}" must have one linear path`);
  }
  if (internal[0]?.target) return { ok: true, nextMemberId: internal[0].target };
  if (external.length === 0) return failure('body tail needs a continuation', true);
  if (external.length !== 1) return failure('body tail must have exactly one continuation');
  return { ok: true, continuationNodeId: external[0]?.target as string };
}

function claimBranchMember(
  memberById: ReadonlyMap<string, FlowNode>,
  edges: FlowEdge[],
  currentId: string,
  previousId: string,
  claimedMemberIds: Set<string>,
): FanOutStructureFailure | null {
  const current = memberById.get(currentId);
  if (!current) return failure('body entry must target a body member');
  if (claimedMemberIds.has(currentId)) return failure('body branches must not join or cross');
  if (['condition', 'fan_out'].includes(current.blockType)) {
    return failure(`body member "${currentId}" cannot branch or contain another Fan Out`);
  }
  const incoming = edges.filter((edge) => edge.target === currentId);
  if (incoming.length !== 1 || incoming[0]?.source !== previousId) {
    return failure(`body member "${currentId}" must have exactly one body predecessor`);
  }
  claimedMemberIds.add(currentId);
  return null;
}

function walkFanOutBranch(
  memberById: ReadonlyMap<string, FlowNode>,
  memberIds: ReadonlySet<string>,
  edges: FlowEdge[],
  fanOutNodeId: string,
  rootNodeId: string,
  claimedMemberIds: Set<string>,
): BranchResolution {
  const nodeIds: string[] = [];
  let currentId = rootNodeId;
  let previousId = fanOutNodeId;

  while (true) {
    const invalidMember = claimBranchMember(
      memberById,
      edges,
      currentId,
      previousId,
      claimedMemberIds,
    );
    if (invalidMember) return invalidMember;
    nodeIds.push(currentId);

    const step = resolveBranchStep(currentId, memberIds, edges);
    if (!step.ok) return step;
    if ('nextMemberId' in step) {
      previousId = currentId;
      currentId = step.nextMemberId;
      continue;
    }
    return {
      ok: true,
      branch: { rootNodeId, tailNodeId: currentId, nodeIds },
      continuationNodeId: step.continuationNodeId,
    };
  }
}

/** Resolve explicitly-owned linear Fan Out branches and their shared continuation. */
export function resolveFanOutStructure(
  nodes: FlowNode[],
  edges: FlowEdge[],
  fanOutNodeId: string,
): FanOutStructureResolution {
  // Ownership is one level deep: removal and the runtimes only ever look at direct members.
  if (nodes.some((node) => node.id === fanOutNodeId && node.parentId)) {
    return failure(
      `(id "${fanOutNodeId}") cannot sit inside another Fan Out — remove it or clear its parentId`,
    );
  }
  const members = nodes.filter((node) => node.parentId === fanOutNodeId);
  if (members.length === 0) return failure('has no body members', true);
  const memberIds = new Set(members.map((node) => node.id));
  const entries = edges.filter((edge) => edge.source === fanOutNodeId);
  if (entries.length === 0) return failure('has no edge to a body branch', true);
  if (entries.some((edge) => !memberIds.has(edge.target))) {
    return failure('body entries must target contained branch roots');
  }
  if (new Set(entries.map((edge) => edge.target)).size !== entries.length) {
    return failure('must not connect to the same body branch more than once');
  }

  const memberById = new Map(members.map((member) => [member.id, member]));
  const claimedMemberIds = new Set<string>();
  const resolved = entries.map((entry) =>
    walkFanOutBranch(memberById, memberIds, edges, fanOutNodeId, entry.target, claimedMemberIds),
  );
  const failed = resolved.find((result) => !result.ok);
  if (failed && !failed.ok) return failed;
  if (claimedMemberIds.size !== memberIds.size) return failure('has disconnected body members');

  const complete = resolved.filter((result) => result.ok);
  const continuationIds = new Set(complete.map((result) => result.continuationNodeId));
  if (continuationIds.size !== 1) return failure('body branches must share one continuation');
  const continuationNodeId = complete[0]?.continuationNodeId;
  if (!continuationNodeId) return failure('body tail needs a continuation', true);

  const branches = complete.map((result) => result.branch);
  const tailIds = new Set(branches.map((branch) => branch.tailNodeId));
  const continuationInputs = edges.filter((edge) => edge.target === continuationNodeId);
  if (
    continuationInputs.length !== tailIds.size ||
    continuationInputs.some((edge) => !tailIds.has(edge.source))
  ) {
    return failure('continuation can only receive edges from this Fan Out body tails');
  }

  return {
    ok: true,
    structure: {
      branches,
      bodyNodeIds: branches.flatMap((branch) => branch.nodeIds),
      continuationNodeId,
    },
  };
}

export function computeFanOutBodyChain(
  nodes: FlowNode[],
  edges: FlowEdge[],
  fanOutNodeId: string,
): string[] {
  const result = resolveFanOutStructure(nodes, edges, fanOutNodeId);
  return result.ok ? result.structure.bodyNodeIds : [];
}
