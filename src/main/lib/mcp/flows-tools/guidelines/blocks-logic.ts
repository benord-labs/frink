import {
  BACK_EDGE_CLEARANCE,
  DAGRE_OPTS,
  FAN_OUT_BODY_TOP,
  FAN_OUT_BOTTOM_PADDING,
  FAN_OUT_CHILD_COLUMN_GAP,
  FAN_OUT_CHILD_STEP,
  FAN_OUT_CHILD_X,
  RF_NODE_HEIGHT,
  RF_NODE_WIDTH,
} from '../../../../../shared/lib/flows/canvas-layout/constants';
import { buildOutputSchemasSection, buildLoopContextSection } from './schema-tables';

const COLUMN_PITCH = RF_NODE_WIDTH + DAGRE_OPTS.nodesep;
const ROW_PITCH = RF_NODE_HEIGHT + DAGRE_OPTS.ranksep;
const FAN_OUT_COLUMN_PITCH = RF_NODE_WIDTH + FAN_OUT_CHILD_COLUMN_GAP;

export function getBlocksLogicGuideline(): string {
  return `# Branches, fan-out and gates

## condition

\`\`\`text
{ predicate: { field: string, operator: "eq"|"neq"|"contains"|"gt"|"gte"|"lt"|"lte"|"truthy"|"falsy", value?: unknown },
  loop?: { maxIterations: number, onMaxReached?: "fail"|"continue" } }
\`\`\`

Use a structured predicate, not JavaScript; \`field\` addresses predecessor outputs (e.g. \`count\` or \`outputs.count\`). Omit value for truthy/falsy. Exactly two outgoing edges, one \`sourceHandle: "true"\`, the other \`"false"\`:

\`\`\`json
[{"id":"yes","source":"check","target":"report","sourceHandle":"true"},{"id":"no","source":"check","target":"done","sourceHandle":"false"}]
\`\`\`

Condition preserves upstream outputs and adds/overwrites \`result\`: \`{ ...upstream, result }\`. Only condition nodes may originate back-edges. Loop \`maxIterations\` is 1–50; there is also an engine per-node iteration guard (default 10).

${buildOutputSchemasSection('condition')}

## fan_out

\`\`\`text
{ arrayField?: string, maxIterations?: number, mode?: "sequential"|"parallel", maxParallel?: number }
\`\`\`

\`arrayField\` selects the predecessor array (default \`items\`); maxIterations 1–50 (default 50). Use sequential mode — the dispatcher rejects parallel mode, so \`maxParallel\` (1–10, default 5) validates but changes nothing. Results cover every item in item order. Body iteration outputs also include truncated/originalCount when the array exceeds maxIterations; truncated items are not processed.

A valid container has:

1. Every body node sets \`parentId\` to the fan_out id.
2. Plain edges from fan_out to distinct contained branch roots; no \`body\`/\`done\` handles and no direct edge to the outside continuation.
3. Linear, disjoint branches: one predecessor per body node, no joins/crossing, cycles, conditions or nested fan_out. Every body member must be reachable from one root.
4. Each tail has exactly one edge to the **same outside continuation**. That continuation accepts edges only from this container's tails; no external predecessor or bypass.

The barrier waits for every branch of every item. Each result is keyed by **branch-root id**, containing that branch's **tail output**:

\`\`\`json
{"results":[{"review":{"summary":"PASS"},"check":{"count":2}}],"totalCount":1,"_fanOutState":"completed"}
\`\`\`

Use \`{{previous.results.0.review.summary}}\`, not \`previous.results.0.summary\`. A Start Task after the barrier replaces these results; create a chat before fan-out if the report needs both data and chat. Body agents without their own Start Task continue the one before the fan-out; put a Start Task inside the body only when each item needs its own branch/PR or isolated context, since it opens one chat per item. Outside this barrier, multiple predecessors use OR semantics, not an all-branches join. A complete patch is in \`examples.md\`.

### Body-root outputs

${buildOutputSchemasSection('fan_out')}

### Continuation outputs

${buildOutputSchemasSection('fan_out_completed')}

${buildLoopContextSection()}

## approval

Config \`{ message?: string }\`; pauses the run until the user approves/rejects in Frink. It does not pass through predecessor outputs.

${buildOutputSchemasSection('approval')}

## end

No config or outgoing edges; terminates a path.

${buildOutputSchemasSection('end')}

## Canvas layout

\`position\` is a node's top-left corner in pixels. Omit it everywhere and the canvas lays the flow out top-to-bottom; a mix of placed and unplaced nodes usually collides.

- A node is ${RF_NODE_WIDTH}×${RF_NODE_HEIGHT} (long content renders taller). Keep at least ${COLUMN_PITCH} between column x values and ${ROW_PITCH} between row y values.
- Edges leave the bottom of a node and enter the top of the next, as curves. Place a target below its source; a target beside or above it draws a long S-curve across the canvas.
- A condition loop edge runs up a vertical stem ${BACK_EDGE_CLEARANCE}px from the target's centre: left for the \`true\` branch, right for \`false\`. Keep that lane clear of other nodes.
- Fan Out body positions are relative to the container's top-left. Defaults: first node at (${FAN_OUT_CHILD_X}, ${FAN_OUT_BODY_TOP}), +${FAN_OUT_CHILD_STEP} y per step, +${FAN_OUT_COLUMN_PITCH} x per branch. The container grows to fit its members plus ${FAN_OUT_BOTTOM_PADDING} below, so leave room under it for the continuation. Its size cannot be set by patch.
- \`{"op":"auto_layout"}\` (once per patch, no other fields) discards every stored position and Fan Out size and restores the default layout after the patch's other operations. Use it when asked, or to clear reported overlaps — it erases the user's manual arrangement. A flow that was never positioned already looks like this.
- Send all moves in one patch; each patch that changes anything saves a version.
- The patch result includes \`layout\` when positions changed or nodes collide: \`bounds\`, \`overlaps\` (node id pairs) and \`upwardEdges\` (edge ids), each with a count and up to 10 samples. Fix what it lists, then re-check.
`;
}
