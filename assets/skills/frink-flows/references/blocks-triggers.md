# Trigger contracts

Exactly one trigger; one outgoing edge and no incoming edge. Triggers supply `trigger.*`, not `previous.*`. Batch runs bypass the trigger and use per-run `triggerContext` instead.

## manual_trigger

Config `{}`. Starts from Run in the app or an authorized MCP run. Accepts caller-defined triggerContext keys such as ticketId. Set label/customInstructions and a root batch's baseBranch as needed; dependency branch fields are injected at dispatch for dependent stages.

| trigger field | type | description |
|---|---|---|
| `label` | string | Per-run display label shown in the Frink Monitor run list. Set by the CEO agent in triggerContext. Falls back to "Run N" when absent. |
| `customInstructions` | string | Run-specific agent instructions editable until dispatch. Merged into the agent system prompt at run time. Max 10 000 characters. |
| `baseBranch` | string | For root batch stages, set triggerContext.baseBranch to the starting branch. For dependent stages, the server resolves and overwrites it from completed dependencies at dispatch; do not precompute their base branch. |
| `baseBranches` | array | Base branches from all completed dependencies, ordered most-recently-completed first (converging DAG deps). Client uses baseBranches[0] as primary base and merges the rest. Provided alongside baseBranch whenever dependency branches resolve, including a single branch. baseBranch equals baseBranches[0]. |
| `mergeStrategy` | string | Merge strategy hint for converging DAG branches; currently always "most-recent". Client-side agent uses baseBranches[0] as primary worktree base. |


## post_task_trigger

Config `{}`; bound at flow level to a project, fires on task completion. Carries chat context for replies; a new agent task still needs Start Task. Use trigger fields to read the completed task after that new Start Task.

| trigger field | type | description |
|---|---|---|
| `taskId` | string | UUID of the completed task |
| `taskTitle` | string | Title of the completed task |
| `taskStatus` | string | Final status of the task |
| `source` | string | How the task was created (e.g. manual, flow, slack) |
| `projectId` | string | UUID of the project the task belonged to |
| `taskCompletedAt` | string | ISO time the task finished |
| `result` | string | Summary the task's agent reported when it finished (not always present) |
| `branch` | string | Git branch the task ran on (not always present) |
| `baseBranch` | string | Base branch the task branched from (not always present) |
| `worktreePath` | string | Absolute path to the task worktree (not always present) |
| `chatId` | string | Chat session ID of the completed task (not always present) |
| `subChatId` | string | Chat tab the completed task ran in (not always present) |
| `projectPath` | string | Main project directory path (not always present) |


## schedule_trigger

Config `{ cronExpression: string, timezone: string }`. Standard five-field cron, e.g. `"0 9 * * *"`, with explicit timezone such as `"UTC"`. A schedule carries no chat; create Start Task before a reply.

| trigger field | type | description |
|---|---|---|
| `scheduledAt` | string | ISO timestamp when this run was scheduled |


## webhook_trigger

Config `{ integrationId: string, eventType: string, conditions?: object }`.
Optional `conditions.filters` is a list of `{ field, operator, value }`; operator is one of `equals`, `not_equals`, `contains`, `in_list`. Only `in_list` takes a list value; the others take text. A filter outside this shape blocks every event.
First call `frink_flows_list_catalog({kind:"integrations"})`; choose a returned integration id and one of its `events[].id` values (not label). Those two fields are the complete binding; no separate trigger rule. Empty catalog/sign-out: ask the user to connect an integration, do not invent ids. The provider must deliver webhooks; endpoint generation/verification may still be needed in Settings → Plugins.

Stored `eventType`/`fullContent` are aliased to `event`/`payload` at runtime. Prefer friendly provider aliases from `webhook-aliases.md`; unlisted providers use raw `trigger.payload.*`.

| trigger field | type | description |
|---|---|---|
| `source` | string | Integration provider (shortcut, gmail, slack, etc.) |
| `event` | string | Webhook event type (alias of eventType) |
| `eventType` | string | Webhook event type |
| `triggeredBy` | object | Actor who caused the event — use dot paths, e.g. triggeredBy.externalUserId |
| `timestamp` | string | ISO time when the trigger fired |
| `sourceAccountId` | string | Connected integration id |
| `integrationId` | string | Connected integration id (same as sourceAccountId) |
| `deliveryId` | string | This delivery's unique id — the provider's own, or a payload fingerprint |
| `payload` | object | Raw provider webhook body. Field names are provider-specific — prefer the friendly fields above (e.g. {{trigger.story.title}}); use payload.* only as an escape hatch. |

