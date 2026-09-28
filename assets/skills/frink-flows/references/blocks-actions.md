# Action contracts

Config below is inside `node.config`; `?` means optional. Output tables are generated from the runtime schema. Outputs replace predecessor data; put Start Task before producing data another block needs.

## start_task

Creates the task/chat and execution environment required before an `agent`.

```text
{ projectId?: string, label?: string, model?: string,
  startMode?: "execute"|"plan"|"wait", startInWorktree?: boolean, branch?: string }
```

`projectId` accepts id/exact name/templates, otherwise flow `defaultProjectId`. Worktrees default off: set `startInWorktree: true` for branch chaining. `branch` is an existing branch to branch FROM, not the new worktree branch name.

| output | type | guaranteed | description |
|---|---|---|---|
| `chatId` | string | yes | Chat session ID created for this flow run — downstream agent blocks continue this chat |
| `subChatId` | string | yes | Default sub-chat ID for this flow session — downstream chat_reply targets this tab |
| `projectId` | string | yes | Project the Start Task is bound to |
| `worktreePath` | string | yes | Absolute path to the git worktree (empty string when startInWorktree is false) |
| `branch` | string | no | Git branch checked out in the worktree |
| `baseBranch` | string | no | Base branch (parent of the working branch) |
| `configured` | boolean | yes | True when the worktree was provisioned; false for no-worktree runs |
| `mergedBranches` | array | no | Dependency branches merged into the converging worktree (sc-612). Absent on single-branch runs; the field may be omitted when not applicable. Available via {{previous.mergedBranches}}. |
| `mergeConflict` | boolean | no | True when a converging merge conflict was detected (node status will be awaiting_input). Absent on clean merges. |
| `conflictingBranch` | string | no | The dependency branch that caused the merge conflict (present when mergeConflict is true). |
| `conflictedFiles` | array | no | File paths with merge conflicts (present when mergeConflict is true). |


## agent

Inherits the upstream Start Task; another Agent follows up in the same task.

```text
{ instructions: string, fireAndForget?: boolean, model?: string,
  mode?: "agent"|"plan"|"debug", autoApprove?: boolean, agentInstructions?: string }
```

`model`/`mode` override inherited settings for this node only. Plan mode pauses for approval unless `autoApprove: true`; debug is local-only and pauses for human reproduction. `agentInstructions` supplies a templated role above the task instructions; the briefing arrives separately in the session system prompt. `instructions` and `agentInstructions` are each limited to 50,000 characters (trimmed): a patch over the limit is rejected, and one at 40,000 or more returns a warning.
A leading `/command` in instructions expands at save time. Discover names with `frink_flows_list_catalog({kind:"commands"})`; unknown commands reject the patch, built-ins such as `/plan` stay literal. Expansion sets `instructionsCommandName` automatically; do not set it manually.

| output | type | guaranteed | description |
|---|---|---|---|
| `summary` | string | no | Short summary the agent reported on completion |
| `details` | string | no | Detailed output the agent reported on completion |
| `chatId` | string | yes | Chat session ID — used by downstream agent and chat_reply blocks |
| `worktreePath` | string | no | Absolute path to the git worktree used by this agent |
| `branch` | string | no | Git branch the agent worked on |
| `baseBranch` | string | no | Base branch |
| `spawnedTaskId` | string | no | Task ID — only present when fireAndForget is true |
| `fireAndForget` | boolean | no | True when agent was launched in async fire-and-forget mode |
| `taskStatus` | string | no | Task status when the node ended in a non-standard state (e.g. needs_attention when agent did not signal). Use {{previous.taskStatus}} to branch on this. |
| `verification` | object | no | Structured verification result from the agent's frink_task_signal call — only present when the agent explicitly includes a verification object. Use dot notation: {{previous.verification.passed}} |


## run_command

```text
{ command: string, projectId?: string,
  workingDirectory?: "project_root"|"trigger_worktree"|"custom", customPath?: string,
  expectedOutputs?: { [key: string]: { type: "string"|"number"|"boolean"|"object"|"array", description?: string } } }
```

`customPath` is required for `custom`. Leave templates bare (`echo prefix {{previous.summary}}`): Frink shell-escapes values. Put logs on stderr and emit one JSON object on stdout. Its top-level keys become outputs; nested keys use dot paths. Invalid/mixed stdout falls back to `_rawStdout`; `expectedOutputs` documents JSON fields for chips/validation and does not create values.

```json
{"id":"count","blockType":"run_command","config":{"command":"printf '{\"count\":3}'","expectedOutputs":{"count":{"type":"number"}}}}
```

| output | type | guaranteed | description |
|---|---|---|---|
| `exitCode` | number | yes | Process exit code (0 = success) |
| `_rawStdout` | string | no | Raw stdout truncated to 4KB — only present when stdout is not valid JSON |


## http_request

```text
{ url: string, method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE",
  headers?: Record<string,string>, body?: string }
```

Method defaults GET; body is not sent for GET/DELETE.

| output | type | guaranteed | description |
|---|---|---|---|
| `status` | number | yes | HTTP response status code (e.g. 200) |
| `statusText` | string | yes | HTTP response status text (e.g. "OK") |
| `body` | string | yes | Response body as a string (truncated at 256KB) |
| `headers` | object | yes | Response headers as key/value pairs. Use dot notation: {{previous.headers.content-type}} |
| `truncated` | boolean | yes | True if the response body was truncated due to size limit |


## chat_reply

Requires a chat on the same path: an upstream Start Task or `post_task_trigger` with `trigger.chatId`.

```text
{ contentType?: "text"|"html_artifact", messageTemplate?: string,
  artifactTitleTemplate?: string, artifactBodyHtmlTemplate?: string }
```

Text (default) requires `messageTemplate`. HTML requires title + HTML body fragment; the user explicitly opens an isolated view. Charts need labels and a text/table alternative. `manual_trigger → run_command → chat_reply` lacks a chat; insert Start Task **before** the command to preserve its outputs.

| output | type | guaranteed | description |
|---|---|---|---|
| `chatId` | string | yes | Chat session ID the message was posted into |
| `subChatId` | string | yes | Sub-chat tab the assistant message was appended to |
| `delivered` | boolean | yes | Whether the message was successfully delivered |
| `message` | string | yes | The rendered text message or interactive artifact title |
| `contentType` | string | yes | Either text or html_artifact |
| `artifactId` | string | no | Stable artifact delivery ID (HTML artifact replies only) |
| `title` | string | no | Rendered preview title (HTML artifact replies only) |


## Connected integration steps

Discover rather than guess: `frink_flows_list_catalog({kind:"nodes"})` returns installed steps/config; add `pluginId` for live tools. If it returns a vocabulary, add `search`; exact tool-name search returns its argument schema. Unknown step names may save then fail at run time. These steps are machine-owned; do not register them yourself.
Use the returned step name as `blockType`, inputs as `config`, and optional `connectionId` to pin an account. Prefer a named step; a `callTool: true` / `<integration>_call_tool` step takes `{tool, arguments?}` for that server's actual tools. Outputs are `text`, `result`, and optional `structured`; other steps declare their own. Refused calls fail the step. Vendor `readOnly`/`destructive` labels are descriptions, not permissions.
