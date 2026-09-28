# Templates and shared context

`{{scope.field}}` uses dot paths; a scalar becomes text, an object/array becomes JSON.

| Scope | Lifetime |
|---|---|
| `trigger.*` | Every node; trigger payload or per-run batch `triggerContext` |
| `previous.*` | Immediate predecessor's outputs only |
| `loop.*` | Every node whose `parentId` names the fan_out; currentItem, currentIndex, totalCount |

Only `condition` passes upstream outputs through: `{ ...upstream, result }`. Every other block replaces them. `run_command → condition → chat_reply` preserves command fields; inserting `start_task` or `agent` loses them. Create the task before producing data, use stable `trigger.*`/`loop.*`, or explicitly persist/re-read it. There is no template-accessible flow KV store.

## Fields that render

| Block | Fields |
|---|---|
| Flow settings | `briefing` (`trigger.*` only) |
| agent | `instructions`, `agentInstructions` |
| start_task | `label`, `branch`, `projectId` |
| run_command | `command`, `projectId` |
| http_request | `url`, each string `headers` value, `body` |
| chat_reply | `messageTemplate`, `artifactTitleTemplate`, `artifactBodyHtmlTemplate` |
| Custom node | Declared top-level inputs, converted to their declared types |
| Integration call-tool | Templates in `arguments` values; use the discovered tool schema |

Other fields are literal. Custom-node `projectId` is static (node config, otherwise flow default).
A rendered project resolves by registered id or exact name. Missing, unknown, or ambiguous names fail; they do not fall back to the flow default.

## Missing values, sizes, shell commands

- Missing keys render empty. Missing values instead fail `start_task.branch`, `projectId`, `run_command.command`, and `http_request.url`. Branch/project/URL also fail on a present-but-blank value; command does not. A command placeholder directly beside `/` (`/tmp/work/{{x}}`, `{{x}}/`) gets a design-time advisory instead, because a blank value collapses the path and still runs; guard destructive paths with `v={{x}}; rm -rf "/tmp/work/${v:?}"`.
- Circular values or serialized values around 50 KB or more remain literal placeholders. Avoid passing large fan-out results through a template; use scalar counts, a single branch result, or inspect the run.
- Command values are shell-escaped automatically. Leave placeholders bare: `echo prefix {{previous.summary}}`. Quote static text only. Quoted placeholders produce an advisory; unanalyzable shell syntax (substitution, backticks, heredocs, unclosed quotes) is not substituted. Total rendered command length is capped around 256 KB.

## Flow Briefing

Shared context lives in `graph.settings.briefing` (max 10,000 characters). It renders `trigger.*` once per run and reaches every agent, including continuation and fire-and-forget agents, once per session in the system prompt. It is not `{{flow.briefing}}` and need not be repeated in agent instructions.

Set it with `frink_flows_patch`:

```json
{"flowId":"<flow-id>","operations":[{"op":"update_settings","settings":{"briefing":"Review each {{trigger.ticketId}} against the agreed checklist."}}]}
```

Setting a previously absent briefing generates `graph.settings.currentBatchId`; use the returned value for batch planning. Clearing with `briefing: ""` closes the batch for new runs. In batch runs, the trigger block is bypassed and the supplied `triggerContext` becomes `trigger.*`; include `label`, a work-item id such as `ticketId`, and optional `workstreamId`/`customInstructions`. Static trigger-schema warnings about these batch-only fields do not imply missing runtime data.
