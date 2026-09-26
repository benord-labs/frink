export function getInspectingRunsGuideline(): string {
  return `# Run and inspect a flow

\`frink_flows_run({flowId})\` requests a run; \`frink_flows_start_batch\` activates a planned batch. Both require the flow's agent-invocable grant. A newly authored flow normally lacks it: call the tool and let Frink's consent card offer Allow once / Always allow this Flow / Deny. Do not send the user to settings unnecessarily.

Read consent outcomes: \`permissionDenied: true\` is a refusal; do not retry. A failure with false is not a refusal: the card may be waiting, expired, consumed by a sibling call or undelivered. A waiting approval means nothing started; report pending and stop. Expiry means nobody answered.

## Inspect without busy polling

1. Read the run id returned by \`frink_flows_run\`.
2. \`frink_flows_get_run({runId, wait:true})\` waits (default 2 minutes; \`timeoutMs\` up to 5 minutes). \`waitTimedOut: true\` means still running; wait again as needed within the 20-call/session budget. Paused/awaiting-input returns early with \`earlyReturn: true\`.
3. Inspect \`run\`, \`nodes\`, \`totalNodeRuns\`, \`shownNodeRuns\`. Drill into full output with \`{runId, nodeRunId}\` (\`nodeDetail\`). Use \`wait:false\` for a snapshot.

\`status:"queued", runStatus:"pending"\` means accepted but awaiting machine admission, not executing. A pending run has no startedAt and can be waited on.

| Entity | Statuses |
|---|---|
| Run | pending, running, completed, failed, cancelled, paused |
| Node | pending, running, completed, failed, cancelled, timed_out, awaiting_input |

Fan-out inspection summarizes \`totalLanes\`, \`completedLanes\`, \`failedLanes\`, \`failedLaneNodeRunIds\`; drill into a failed id. This summary is distinct from continuation \`previous.results\`, which is keyed by branch-root id per item.
\`attemptNumber > 1\` marks an automatic retry; inspect \`retryable\` and the error.

## Pauses and failures

Approval, questions and failure checkpoints pause the run. Awaiting nodes have \`awaiting_input\`; users approve/retry in the Flow UI. Agents cannot directly resume paused runs.
Default node failure terminates the run. Set \`graph.settings.pauseOnFailure: true\` with an \`update_settings\` patch to preserve pending execution state and let the user Retry or Skip in the UI. Paused runs retain their machine-admission slot until terminal; persisted state survives restarts/offline periods.

To change a saved flow, fetch its current graph and patch its \`flowId\`; do not create duplicates. Read the patch response: saved topology does not establish valid execution config or a successful run.
`;
}
