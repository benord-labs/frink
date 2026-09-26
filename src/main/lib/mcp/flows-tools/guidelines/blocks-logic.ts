import { buildOutputSchemasSection, buildLoopContextSection } from './schema-tables';

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
`;
}
