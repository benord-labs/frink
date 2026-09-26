# Branches, fan-out and gates

## condition

```text
{ predicate: { field: string, operator: "eq"|"neq"|"contains"|"gt"|"gte"|"lt"|"lte"|"truthy"|"falsy", value?: unknown },
  loop?: { maxIterations: number, onMaxReached?: "fail"|"continue" } }
```

Use a structured predicate, not JavaScript; `field` addresses predecessor outputs (e.g. `count` or `outputs.count`). Omit value for truthy/falsy. Exactly two outgoing edges, one `sourceHandle: "true"`, the other `"false"`:

```json
[{"id":"yes","source":"check","target":"report","sourceHandle":"true"},{"id":"no","source":"check","target":"done","sourceHandle":"false"}]
```

Condition preserves upstream outputs and adds/overwrites `result`: `{ ...upstream, result }`. Only condition nodes may originate back-edges. Loop `maxIterations` is 1–50; there is also an engine per-node iteration guard (default 10).

| output | type | guaranteed | description |
|---|---|---|---|
| `result` | string | yes | "true" on the true branch, "stop" on the false branch |


## fan_out

```text
{ arrayField?: string, maxIterations?: number, mode?: "sequential"|"parallel", maxParallel?: number }
```

`arrayField` selects the predecessor array (default `items`); maxIterations 1–50 (default 50). Use sequential mode — the dispatcher rejects parallel mode, so `maxParallel` (1–10, default 5) validates but changes nothing. Results cover every item in item order. Body iteration outputs also include truncated/originalCount when the array exceeds maxIterations; truncated items are not processed.

A valid container has:

1. Every body node sets `parentId` to the fan_out id.
2. Plain edges from fan_out to distinct contained branch roots; no `body`/`done` handles and no direct edge to the outside continuation.
3. Linear, disjoint branches: one predecessor per body node, no joins/crossing, cycles, conditions or nested fan_out. Every body member must be reachable from one root.
4. Each tail has exactly one edge to the **same outside continuation**. That continuation accepts edges only from this container's tails; no external predecessor or bypass.

The barrier waits for every branch of every item. Each result is keyed by **branch-root id**, containing that branch's **tail output**:

```json
{"results":[{"review":{"summary":"PASS"},"check":{"count":2}}],"totalCount":1,"_fanOutState":"completed"}
```

Use `{{previous.results.0.review.summary}}`, not `previous.results.0.summary`. A Start Task after the barrier replaces these results; create a chat before fan-out if the report needs both data and chat. Body agents without their own Start Task continue the one before the fan-out; put a Start Task inside the body only when each item needs its own branch/PR or isolated context, since it opens one chat per item. Outside this barrier, multiple predecessors use OR semantics, not an all-branches join. A complete patch is in `examples.md`.

### Body-root outputs

| output | type | guaranteed | description |
|---|---|---|---|
| `currentItem` | unknown | yes | Current array element for this iteration — shape depends on the upstream array. Use dot notation for object fields: {{previous.currentItem.title}} |
| `currentIndex` | number | yes | Zero-based index of the current iteration |
| `totalCount` | number | yes | Total number of items being iterated |
| `arrayField` | string | yes | Name of the field from the upstream output that is being iterated |


### Continuation outputs

| output | type | guaranteed | description |
|---|---|---|---|
| `results` | array | yes | One record per item, keyed by branch-root node id. Each value is that branch tail's `outputs` record. Use `{{previous.results.0.<branchRootNodeId>.summary}}` for scalar access. Large arrays (>25 items) can exceed the 50 KB template cap — prefer API fetch. |
| `totalCount` | number | yes | Total number of items processed across all parallel or sequential iterations (including skipped lanes). In parallel mode this equals the fan_out item count, not the per-wave lane cap. |
| `_fanOutState` | string | yes | Internal marker set to "completed" when all lanes have finished. Used by the UI to detect fan-out completion outputs vs iteration outputs. |


## Loop context schemas (`{{loop.*}}`)

Available on every node owned by a fan_out through `parentId`.
`{{loop.currentItem.*}}` fields depend on the upstream node feeding the fan_out.

| field | type | guaranteed | description |
|-------|------|------------|-------------|
| `currentIndex` | number | yes | Zero-based index of the current iteration (0 = first item) |
| `totalCount` | number | yes | Total number of items being iterated |
| `currentItem` | unknown | yes | Current array element — use dot notation for object fields: `{{loop.currentItem.title}}` |


## approval

Config `{ message?: string }`; pauses the run until the user approves/rejects in Frink. It does not pass through predecessor outputs.

Outputs: none.


## end

No config or outgoing edges; terminates a path.

Outputs: none.

