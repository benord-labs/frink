# Batch orchestration

Use stages for many work items. `dependsOn` means “needs the completed dependencies' code.” The planning agent defines the DAG; Frink dispatches and advances it. Employees have separate chats and share the Flow Briefing.

## Plan → define → start

1. Fetch a compact manifest (`id`, title, labels, blockedBy, blocks, optional priority/estimate). Group related work by module; read full descriptions in manageable groups. Check cross-stream file overlap, dependencies, convergence, testability, failure isolation and bottlenecks. Put PR instructions only on leaves of dependent chains; independent roots may open their own PRs.
2. Present the dependency tree, workstreams and PR ownership for user confirmation before `frink_flows_define_stages`. Incorporate requested changes. Do not create stages for an unconfirmed plan.
3. Set the shared briefing through `frink_flows_patch` and read `graph.settings.currentBatchId` from its response. No dummy/seeding run is needed.
4. Define stages. Each run needs a meaningful `label` and work-item id (`ticketId` for tickets); `workstreamId` groups the canvas. `customInstructions` can specialize a run and is where reference links (Figma, docs) belong — URLs only, not inline content (10,000-character triggerContext limit). `triggerContext.attachments` carries only images uploaded to the run from the Monitor; a link listed there is not sent to the agent.
5. After every intended stage is defined successfully, call `frink_flows_start_batch({ flowId, batchId })`. Stages are pending until then. `started: true` means a root stage activated; its Flow runs may still be queued for machine admission.
6. Report the batch id and exit. Monitor/broadcast only when requested; Frink advances dependencies without a supervising agent.

Example tool arguments (replace ids with discovered values):

```json
{
  "flowId":"<flow-id>", "batchId":"<currentBatchId>",
  "stages":[
    {"stageNumber":1,"name":"Schema","runs":[{"triggerContext":{"label":"Auth schema","ticketId":"sc-101","workstreamId":"auth","baseBranch":"0.0.12"}}]},
    {"stageNumber":2,"name":"API","dependsOn":[1],"runs":[{"triggerContext":{"label":"Auth API","ticketId":"sc-102","workstreamId":"auth"}}]},
    {"stageNumber":3,"name":"UI","dependsOn":[1],"runs":[{"triggerContext":{"label":"Auth UI","ticketId":"sc-103","workstreamId":"auth"}}]},
    {"stageNumber":4,"name":"Integration","dependsOn":[2,3],"runs":[{"triggerContext":{"label":"Integration and PR","ticketId":"sc-104"}}]}
  ]
}
```

## Limits and recovery

| Tool | Per-session limit / per-call bounds |
|---|---|
| frink_flows_patch | 5 creates + 15 modifications |
| frink_flows_run | 5 successful runs; stages support larger batches |
| frink_flows_define_stages | 20 calls; 50 stages/call, 50 runs/stage/call |
| frink_flows_add_stage_runs | 20 calls; 50 runs/call; pending stages only |
| frink_flows_start_batch | 5 calls; idempotent |
| frink_batch_message | 10 calls |
| frink_flows_get_run | 20 calls |
| frink_flows_get_batch | 40 calls across all modes |

For >50 stages, define in multiple calls: `dependsOn` can reference stage numbers from earlier calls. Keep the returned stageNumber→UUID map; use UUIDs when patching dependencies. Fan-in ≤10, no depth limit, cycles rejected.
If define returns `success: "partial"` (207), retry only the `failedStages` stage numbers with their **full run lists**. Existing runs for those failed stages are replaced; partial rows are cancelled and stages reset to pending. Do not start an incomplete batch.

## Branch inheritance and PRs

Every stage's Start Task must explicitly set `startInWorktree: true` (default false). Its `branch` is an existing branch to branch FROM, never the new branch name. For root runs, set an existing base either in Start Task config or per run as `triggerContext.baseBranch` with `branch: "{{trigger.baseBranch}}"`.

For dependent stages, do not prepopulate `baseBranch`/`baseBranches`: at dispatch Frink collects branches from **all completed runs in all dependencies**, deduplicates, orders most recently completed first and injects:

| Unique branches | Context |
|---|---|
| 0 | Unchanged (no inherited code) |
| 1 | `baseBranch` and `baseBranches: [branch]` |
| 2+ | `baseBranch`, all `baseBranches`, `mergeStrategy: "most-recent"` |

The desktop client uses `baseBranches` to provision the worktree and automatically merges dependency branches. Do not instruct agents to run these merges. Start Task outputs include `mergedBranches`, `mergeConflict`, `conflictingBranch`, `conflictedFiles`; a conflict pauses for input. Intermediate stages commit/push; the leaf PR contains the entire accumulated chain, including convergence work.

## Two concurrency limits

`graph.settings.maxBatchConcurrency` accepts 1–20 (default 5), but local per-stage dispatch clamps to 5, so values 6–20 are accepted for schema compatibility without raising throughput.
Machine-wide Flow admission is independent: Settings → Preferences → Flows defaults to enabled/4 top-level local Flow runs. Ordinary chats do not count. Excess stage-runs remain pending; queued stage-runs may have an accepted Flow run still `pending`. Paused/approval/question waits retain their slot; completed/failed/cancelled runs release it.

## Inspect and correct, when requested

- `frink_flows_get_batch({ flowId })` lists runs; add `batchId` for summary and `include: ["stages"]` for stages.
- `frink_flows_get_run({ runId, wait: false })` drills into a run.
- `frink_batch_message({ flowId, batchId, message })` sends a correction; add `flowRunId` to target one. Active runs queue a continuation; terminal runs get one immediately.
- Clear briefing with an `update_settings` patch when finished to close the grouping for new runs.
