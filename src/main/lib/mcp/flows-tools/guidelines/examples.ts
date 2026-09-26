export function getExamplesGuideline(): string {
  return `# Worked flow and patterns

## Condition → fan-out → HTML report

Pass the following JSON as arguments to \`frink_flows_patch\`. Run in a selected project (or supply its discovered projectId). Commands use only printf/echo and make no external calls. Start Task creates the chat before the array is produced; its wait mode avoids starting a free-running agent. The condition checks the array before fan-out; the two contained branches share the HTML reply outside the container.

\`\`\`json
{"name": "Fan-out report", "operations": [
  {"op":"add_node","node":{"id":"trigger","blockType":"manual_trigger"}},
  {"op":"add_node","node":{"id":"chat","blockType":"start_task","config":{"label":"Fan-out report","startMode":"wait"}}},
  {"op":"add_node","node":{"id":"items","blockType":"run_command","config":{"command":"printf '{\\"items\\":[\\"alpha\\",\\"beta\\"],\\"count\\":2}' ","expectedOutputs":{"items":{"type":"array"},"count":{"type":"number"}}}}},
  {"op":"add_node","node":{"id":"fan","blockType":"fan_out","config":{"arrayField":"items","mode":"sequential"}}},
  {"op":"add_node","node":{"id":"review","blockType":"run_command","parentId":"fan","config":{"command":"echo {{loop.currentItem}}"}}},
  {"op":"add_node","node":{"id":"count","blockType":"run_command","parentId":"fan","config":{"command":"printf '{\\"count\\":1}' ","expectedOutputs":{"count":{"type":"number"}}}}},
  {"op":"add_node","node":{"id":"check","blockType":"condition","config":{"predicate":{"field":"count","operator":"gt","value":0}}}},
  {"op":"add_node","node":{"id":"report","blockType":"chat_reply","config":{"contentType":"html_artifact","artifactTitleTemplate":"Item report","artifactBodyHtmlTemplate":"<h1>Processed {{previous.totalCount}} items</h1><p>First result: {{previous.results.0.review._rawStdout}}</p>"}}},
  {"op":"add_node","node":{"id":"empty","blockType":"chat_reply","config":{"messageTemplate":"No items to process."}}},
  {"op":"add_edge","edge":{"id":"e0","source":"trigger","target":"chat"}},
  {"op":"add_edge","edge":{"id":"e1","source":"chat","target":"items"}},
  {"op":"add_edge","edge":{"id":"e2","source":"items","target":"check"}},
  {"op":"add_edge","edge":{"id":"e3","source":"fan","target":"review"}},
  {"op":"add_edge","edge":{"id":"e4","source":"fan","target":"count"}},
  {"op":"add_edge","edge":{"id":"e5","source":"review","target":"report"}},
  {"op":"add_edge","edge":{"id":"e6","source":"count","target":"report"}},
  {"op":"add_edge","edge":{"id":"e7","source":"check","target":"fan","sourceHandle":"true"}},
  {"op":"add_edge","edge":{"id":"e8","source":"check","target":"empty","sourceHandle":"false"}}
]}
\`\`\`

The continuation receives this shape (one record per item, each keyed by the branch-root id):

\`\`\`json
{
  "results": [
    {
      "review": {
        "exitCode": 0,
        "_rawStdout": "alpha"
      },
      "count": {
        "exitCode": 0,
        "count": 1
      }
    },
    {
      "review": {
        "exitCode": 0,
        "_rawStdout": "beta"
      },
      "count": {
        "exitCode": 0,
        "count": 1
      }
    }
  ],
  "totalCount": 2,
  "_fanOutState": "completed"
}
\`\`\`

The condition preserves the producer fields for fan-out; the HTML reply directly consumes the barrier result. Do not insert Start Task between the barrier and report; it would replace the results. Fan-out entry/tail edges have no handles; only the condition edges use true/false.

## Other common shapes

| Intent | Shape and required data |
|---|---|
| Review a completed task | post_task_trigger → start_task → agent → approval. Agent instructions explicitly use trigger.result/branch/worktreePath to refer to the completed task; start_task creates a new task. Set startInWorktree true if a separate worktree is required. |
| Scheduled maintenance | schedule_trigger → start_task → run_command → chat_reply. Set cronExpression/timezone; print JSON + expectedOutputs for a structured summary, or read _rawStdout for plain text. |
| Webhook conditional action | webhook_trigger → run_command → condition → (true: start_task → agent, false: end). Bind a real catalog integration/event; have the command exit 0 and emit a boolean for a business-condition false result—nonzero exits fail before the condition. Agent uses trigger fields or re-reads data after Start Task. |
| Review open PRs | schedule_trigger → start_task → run_command → condition → (true: agent, false: end). In the command, use authenticated gh to produce prs/count JSON with expectedOutputs. Agent instructions explicitly reference previous.prs; put Start Task before the command. |
| Scheduled multi-area sweep | schedule_trigger → start_task (startInWorktree) → run_command (workingDirectory trigger_worktree) → condition → fan_out[agent → agent] → run_command → chat_reply. One session, one branch, one PR: body agents continue the outer Start Task; each item commits and leaves the tree clean. |
| Many tickets | Define a batch DAG; use the batching guide for confirmation, branches, dependencies and PR-at-leaf. |

## Large reports

\`previous.results\` includes all waves, but a template expansion around 50 KB remains literal. Prefer small summaries, scalar totalCount or an individual branch result; a reporting agent can inspect the run via MCP. If an authenticated run API is already available, explicitly supply its URL/credentials/run id in the command; Frink injects no API URL or token into command environments. Flatten each item with Object.values(item) before counting branch outcomes; do not flatten away the branch id when you need per-branch attribution.
`;
}
