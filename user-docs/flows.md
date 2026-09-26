# Flows

Flows are visual automation pipelines that connect triggers, commands, agents, and logic into repeatable workflows. You build them in the Flow Editor by wiring blocks together, and they run on your machines whenever their trigger fires.

This guide covers how flows work, with particular emphasis on how data moves between blocks — the most common source of confusion.

## Anatomy of a flow

Every flow has:

1. **Exactly one trigger** — the event that starts the flow (manual, webhook, schedule, or post-task)
2. **One or more action/logic blocks** — the work the flow performs
3. **Edges** — connections between blocks that define execution order

Blocks execute top-to-bottom following the edges. When a block completes, its outputs become available to the next block via `{{previous.*}}` template variables.

## Copying a flow

Open a flow row's **⋯** menu and choose **Duplicate** to copy its latest saved version. The new flow appears in the list with its name suffixed by “(copy)”, while your current selection stays unchanged. Unsaved editor changes, earlier versions, and run history are not included.

Copies always start paused, even when the source flow is active. Agent invocation permission is preserved. Trigger-binding configuration is also preserved, but every copied binding starts inactive and must be explicitly reactivated before it can fire.

## Project defaults

Steps that run in a project (`start_task`, `run_command`, your own custom nodes) resolve their project as **node override → flow default** (`graph.settings.defaultProjectId`, set in **flow settings → Project**). A node override may be a `{{…}}` template, letting an upstream step decide the target project at run time; the flow default then applies only when the node's field is left blank — an override that renders to nothing fails the step rather than inheriting it. Picking a project when creating a flow seeds the flow default automatically, so new steps inherit it without per-node setup. When a step has no project from either source, its amber warning and the node config panel both link straight to the flow settings Project field. Integration steps from an installed plugin are the exception: they run through the plugin's connected account, take no project, and show no project field or warning. Agents creating flows via MCP get the same behavior: the creation `projectId` (or, when omitted, the chat session's project) becomes the flow default.

## Custom nodes (Flow Editor)

If your flow uses **custom** node types (from `~/.frink/nodes/`), the header shows a **custom node health** control only when there is something to report (for example local manifest or cloud catalog issues). When everything looks fine, it stays hidden. Use **Sync to cloud** on one of your own custom steps’ **config** panel when you want to push manifests without waiting for a warning. Integration steps have no such panel — Frink writes and removes their definitions for you when you connect or disconnect the plugin.

Custom nodes are global packages installed under `~/.frink/nodes/`. Their source folders contain `manifest.json`, one plain JavaScript ES module entrypoint, and optional local `.js`/`.mjs` modules and colocated data files. Code can use relative ESM imports, while resources can be loaded with standard APIs such as `readFile(new URL('./image.png', import.meta.url))`. Frink captures every allowed package file and verifies the copied bytes, so author code does not need signatures or checksums for copy verification. Source packages omit `package.json`—Frink creates the installed ESM boundary and managed metadata.

Registration is agent-mediated: the agent registers a simple node inline in one call, or points at an ordinary folder (for nodes bundling images, data files, or extra modules); the current project is context, not ownership. Frink installs the only durable copy at `~/.frink/nodes/<name>` and shows one trusted create-or-replace preview—including every JavaScript module—before it tests or installs anything. Custom nodes run unsandboxed with Frink's bundled Node environment and inherited credentials, so review the source and requested credentials before allowing it. They execute locally while the Frink desktop app is online; offline server task fallback is not available. Use a `run_command` block when a step needs another language, dependencies, or an external interpreter.

**Using a variable in a typed field.** A number or checkbox input can't hold `{{previous.count}}` as text, so those fields carry a small **`{}`** toggle: switch it on to swap the control for a variable box, and off to go back to the fixed value you started from. Frink converts the resolved text back to the field's declared type before the node runs — a number field receives a real number, not `"12.5"`. Use one whole variable and nothing around it (`{{previous.count}}`, not `v{{previous.count}}`); the editor flags anything else. If a variable resolves to something that can't be converted, the step fails and names the input, rather than passing the raw text to your script. Text fields are unchanged — they still accept variables mixed into ordinary prose.

## Run history

The **Run history** panel lists **executable steps**, not the trigger block — the trigger is what started the run; execution begins on the first connected block. Saving the flow stores **canvas positions** for every node (including auto-layout), so step order matches the diagram; older saved graphs without positions are ordered by walking **edges from the trigger** instead.

Deleting a flow is permanent: Frink stops its active work and removes the flow, its run history, and its work-queue tasks. Stashed briefings remain available.

## Flow briefing

**Flow briefing** is optional shared text stored in **flow settings** (`graph.settings.briefing`). When set, the engine delivers it once per flow session as a **system prompt** to **every** Agent in the run — so all agents see the same PRD, checklist, or constraints without you pasting them into each node, and it is never repeated in each agent's message.

- **Where to edit:** Flow Editor → open **Settings** (toolbar) → **Briefing** textarea. An indicator on the canvas shows when briefing is active.
- **Length:** Up to **10,000 characters** (~2,500 tokens).
- **Template variables:** The briefing is shared across the whole flow and rendered **once per run** against `{{trigger.*}}` only — `{{previous.*}}` and `{{loop.*}}` (per-node / per-iteration) do not apply inside a briefing.
- **Clearing:** Delete the text in Settings, or clear it via MCP.
- **Stashing:** Use the **Stash** button (appears when a briefing is active) to save the briefing for later and clear it in one step. Restore any saved stash from the **Restore** dropdown — see [Stashing and restoring briefings](#stashing-and-restoring-briefings).

**When to use it:** Many similar tickets, bulk refactors, or any case where you want one shared spec and per-step instructions in each Agent block.

### Stashing and restoring briefings

**Stash** saves your current briefing as a named snapshot and clears the active briefing — useful when switching between epics or work contexts.

1. Open **Settings** → find the **Briefing** section.
2. Click **Stash** (visible when a briefing is active).
3. Enter a name (e.g. "Epic 579 briefing") and confirm.

The briefing is saved and cleared. Up to **50 stashes** per user. Duplicate names are allowed — creation date disambiguates them in the list.

**Restore** applies a saved stash to the current flow:

1. Click **Restore** → pick a stash from the dropdown (shows name, source flow, and a content preview).
2. If the current flow already has an active briefing, you'll be asked to confirm before replacing it.
3. The stash content is loaded into the **Briefing** textarea. Save the flow (⌘S / Ctrl+S) to persist it.

Restoring does not delete the stash — use the **trash icon** on the stash row to delete it separately.

Stashes are user-scoped: you can save from one flow and restore to any other flow. The source flow name is stored as display metadata only — stashes survive if the original flow is deleted.

### Which agents receive the briefing?

**Every Agent in the flow** — primary, continuation, and fire-and-forget alike. The briefing rides the session system prompt, so it is shared context for the whole run and is delivered once, not repeated in each agent's message. You never reference it in an agent's instructions — write each Agent's `instructions` as the specific step, and the shared PRD/spec is always in context.

## Integration context card (desktop agent chat)

In the **desktop app**, when an **Agent** block opens or continues a chat (for example a sub-chat named “Task Execution”), Frink may show a compact **integration card** above the instructions — the same style as Shortcut story, Gmail, or Slack summaries.

- **Flow Agent blocks:** The card is included **only** when the agent’s **`instructions`** or the flow **briefing** contains a reference to the trigger scope: `{{trigger.` … `}}`. Optional whitespace after `{{` is allowed (same as [Template variables](#template-variables)). That way an early agent that only says “hello” or uses only `{{previous.*}}` does not repeat the trigger card; a later agent that says “summarize `{{trigger.payload}}`” will show it.
- **Tasks created directly from a trigger** (not via a flow Agent block): behavior is unchanged — the card still appears when rich trigger metadata exists.

## Template variables

Template variables let you inject dynamic data into block configs. They use double-brace syntax: `{{scope.field}}`.

There are four scopes:

| Scope | Available where | What it contains |
|-------|----------------|-----------------|
| `{{trigger.*}}` | Every block in the flow | Context from whatever triggered the flow (event payload, task result, etc.) |
| `{{previous.*}}` | Any block with a predecessor | Outputs from the **immediately preceding block only** |
| `{{loop.*}}` | Blocks inside a fan_out body | Current iteration item, index, and count |

There is no `{{flow.*}}` scope: the [Flow briefing](#flow-briefing) is delivered once per session as a system prompt to every agent, so you never reference it in instructions.

**Rendering rules:** Scalar values expand as text. **Object/array leaves** (e.g. `{{trigger.payload}}` when payload is an object) expand as **JSON**. A placeholder naming a field that **isn't there** — a step's optional output that this run didn't produce, or a typo — renders as an **empty string**; it never leaves the `{{...}}` text in place, because that text is not empty and reads like real data. (Where a missing value would be silently wrong or destructive — a project, a branch, a **shell command**, or a request **URL** — the step fails instead and names the variable, so a missing `{{previous.dir}}` never turns `rm -rf /tmp/work/{{previous.dir}}` into `rm -rf /tmp/work/`. A project, a branch, or a URL *path* also fails on a value that is present but blank; a shell command does not, so guard destructive commands against blank values yourself.) Very large serialized values (about 50KB+ per placeholder) and **circular** objects do not expand (the placeholder stays as written, so nothing is silently dropped). **Shell commands** (`run_command`) shell-escape each resolved value automatically and cap total rendered length (about 256KB total) to avoid oversized argv. Leave placeholders bare and quote only static literal text: `echo prefix {{previous.summary}}` is correct. Frink context-escapes existing quoted placeholders for compatibility, but older versions could let untrusted trigger or webhook values escape the intended quote boundary and become executable shell syntax. Placeholders inside syntax Frink cannot confidently analyze (command substitution, backticks, heredocs, unclosed quotes) are **not** substituted — they stay literal, and the flow editor warns about them.

### Which config fields support template variables?

Not every field in a block's config is template-rendered. Only these fields resolve `{{...}}` at runtime:

| Block type | Template-rendered fields |
|-----------|------------------------|
| Flow settings (graph) | `briefing` — delivered once per session as a system prompt to every agent; rendered against `{{trigger.*}}` only (see [Flow briefing](#flow-briefing)) |
| `agent` | `instructions` |
| `run_command` | `command`, `projectId` |
| `start_task` | `label`, `branch`, `projectId` |
| `chat_reply` | `messageTemplate` in Text mode, or `artifactTitleTemplate` and `artifactBodyHtmlTemplate` in Interactive view mode |
| `http_request` | `url`, each string `headers` value, and `body` (the body is not sent for GET) |
| Custom node | Every declared top-level input (resolved text is converted to the input's declared type) |

Other fields (like `method` and nested strings) are used as-is.

A rendered `projectId` is matched against your registered projects by id **or by exact name**, so a
trigger payload can route a run to the project it names (`{{trigger.project}}` → `devkit`). It never
silently falls back: a template that resolves to nothing, to no project, or to a name shared by two
projects fails the step with a message naming the value. Custom nodes are unchanged: their `projectId` is read statically and is not template-rendered.

## Chat Reply: you need a chat session

A **Chat Reply** block posts a templated message into an existing Frink chat. At run time the engine needs a **`chatId`**. The graph validator enforces one of:

1. **Post-Task trigger** — the completed task’s chat is in the trigger context (`trigger.chatId`), or  
2. **Upstream Start Task** on the same path — Start Task creates the flow chat before any Chat Reply on that branch.

So **`manual_trigger → run_command → chat_reply`** is invalid unless you insert **Start Task** before the reply (or use a post-task flow). Use **End** or **HTTP Request** if you only need to stop or call an external URL without a chat.

Chat Reply can return either text or an **Interactive view**. A view is useful when a message is easier to work with as a generated report: for example, a collated message digest with filters, a labelled chart with its underlying table, or a one-off dashboard. It appears inert in the transcript and expands inside its originating message only after you choose **Run artifact**.

One artifact can remain expanded per chat pane. Each body is limited to 65,536 bytes. The isolated view has no network, navigation, storage, popups, permissions, downloads, or browser profile, so use the separate browser workflow for live URLs and MCP Apps for tool-owned UIs.

## How `{{previous.*}}` works — the one-hop rule

This is the single most important thing to understand about flows:

**`{{previous.*}}` always refers to the outputs of the immediately preceding block — and only that block. There is no accumulated context.**

```
run_command (outputs: exitCode, timestamp, count)
    ↓
chat_reply (can use: {{previous.exitCode}}, {{previous.timestamp}}, {{previous.count}})
    ↓
agent (can use: {{previous.chatId}}, {{previous.delivered}}, etc. — chat_reply's outputs. timestamp and count are GONE)
```

After the `chat_reply` block runs, it replaces the previous outputs with its own (`chatId`, `delivered`, `message`, etc.). The `run_command` outputs are no longer accessible.

### The exception: condition blocks

`condition` is the **only** block type that passes upstream outputs through. At runtime, a condition's output is `{ ...upstream, result }` — it copies everything from its predecessor and adds its own `result` field.

```
run_command (outputs: exitCode, timestamp, count)
    ↓
condition (outputs: exitCode, timestamp, count, result)  ← passes through ALL upstream
    ↓ true branch
chat_reply (can use: {{previous.exitCode}}, {{previous.timestamp}}, {{previous.count}}, {{previous.result}})
```

This is why `run_command → condition → chat_reply` preserves the run_command's outputs, but `run_command → agent → chat_reply` does not.

### What each block type outputs

| Block type | `{{previous.*}}` fields available to the next node |
|-----------|---------------------------------------------------|
| `run_command` | `exitCode` (always). If stdout is valid JSON: all top-level JSON keys. If not JSON: `_rawStdout`. |
| `condition` | Everything from its predecessor + `result` (pass-through) |
| `start_task` | `chatId`, `projectId`, `worktreePath`, `branch`, `baseBranch`, `configured` |
| `agent` | `summary`, `details`, `chatId`, `worktreePath`, `branch`, `baseBranch`, `spawnedTaskId`, `fireAndForget` |
| `http_request` | `status`, `body`, `headers` |
| `chat_reply` | `chatId`, `subChatId`, `delivered`, `message`, `contentType`; an Interactive view also returns `artifactId` and `title` |
| `fan_out` | `currentItem` (the array element for this iteration) |
| `approval` | Nothing (pauses the flow) |

## Exporting custom variables from `run_command`

If your shell command prints **valid JSON to stdout**, every top-level key in that JSON becomes a `{{previous.*}}` variable for the next block.

### Example

```bash
echo '{"timestamp": "2026-04-01", "count": 42, "status": "healthy"}'
```

This makes three variables available downstream:
- `{{previous.timestamp}}` → `"2026-04-01"`
- `{{previous.count}}` → `42`
- `{{previous.status}}` → `"healthy"`

Plus the always-present `{{previous.exitCode}}`.

### Rules for JSON stdout export

1. **The entire stdout must be valid JSON.** If any non-JSON text is mixed in (logs, warnings, debug output), the whole thing falls back to `_rawStdout` as a raw string.
2. **Only top-level keys become variables.** Nested objects are accessible via dot notation: `{{previous.data.name}}`.
3. **`exitCode` is always present** regardless of stdout content.
4. **If stdout is not JSON**, only `exitCode` and `_rawStdout` are available.

### Declaring expected outputs (recommended)

By default, the flow editor and validator don't know what JSON fields your command will produce — they can only show `exitCode` and `_rawStdout` as guaranteed fields.

To fix this, add `expectedOutputs` to the run_command node config. This tells the system what fields your command will output, enabling:

- **Variable chips** in the Available Variables panel for downstream nodes
- **Strict validation** of `{{previous.*}}` references (hard warnings for undeclared fields)
- **Agent awareness** — agents using the MCP tools will see the declared fields

You can declare outputs in the Flow Editor by clicking on a `run_command` node and filling in the "Declared outputs" JSON field:

```json
{
  "timestamp": { "type": "string", "description": "ISO timestamp of execution" },
  "count": { "type": "number", "description": "Number of items processed" }
}
```

Each entry needs at minimum a `type` (`string`, `number`, `boolean`, `object`, or `array`). The `description` is optional but helpful.

### What happens without `expectedOutputs`?

Without declared outputs, the Available Variables panel shows only `exitCode` and `_rawStdout` with a note about dynamic fields. The validator emits advisory warnings for any `{{previous.customField}}` references — meaning it can't confirm whether the variable will actually exist at runtime.

With declared outputs, undeclared field references produce hard warnings, and declared fields show as clickable chips in the UI.

## `{{trigger.*}}` variables

Trigger variables are available on **every block** in the flow — they don't follow the one-hop rule.

What's available depends on the trigger type:

### post_task_trigger

| Field | Description |
|-------|------------|
| `trigger.taskId` | UUID of the completed task |
| `trigger.taskTitle` | Title of the completed task |
| `trigger.taskStatus` | Final status |
| `trigger.result` | Result summary |
| `trigger.branch` | Git branch the task ran on |
| `trigger.baseBranch` | Base branch the task branched from |
| `trigger.worktreePath` | Absolute path to the task worktree |
| `trigger.projectId` | UUID of the project |
| `trigger.chatId` | Chat session ID |
| `trigger.projectPath` | Main project directory path |
| `trigger.source` | How the task was created |

### schedule_trigger

| Field | Description |
|-------|------------|
| `trigger.scheduledAt` | ISO timestamp of when this run was scheduled |

### webhook_trigger

| Field | Description |
|-------|------------|
| `trigger.event` | Webhook / integration event type (alias of stored `eventType`) |
| `trigger.payload` | Raw integration payload (alias of stored `fullContent`; object — at a leaf, expands as JSON, or use dot notation e.g. `trigger.payload.story.name`) |
| `trigger.eventType` | Same as `trigger.event` (stored field name) |
| `trigger.fullContent` | Same as `trigger.payload` (stored field name) |

For other integration-specific top-level fields (`triggerRuleName`, `sourceAccountName`, `timestamp`, `relatedContext.*`, etc.), use the paths shown in the Available Variables panel.

#### Generic webhook

The **Generic Webhook** plugin (Settings → Plugins → Generic Webhook → **Connect**) gives you a dedicated secret URL that any external system can `POST` JSON to in order to start a flow — no provider-specific connector required.

1. **Connect** a Generic Webhook integration with a label (e.g. "Stripe", "CI").
2. **Generate an endpoint** in its detail dialog to get a URL (`…/api/triggers/generic_webhook/<token>`) and a signing secret.
3. Build a flow whose **Webhook Trigger** block is bound to that integration. The event is always `received`; the parsed JSON body is available as `{{trigger.payload.body.*}}` (alias `{{trigger.fullContent.body.*}}`) — e.g. `{{trigger.payload.body.amount}}` — and request headers as `{{trigger.payload.headers.*}}`. (`{{trigger.payload}}` resolves to the whole `{ body, headers, deliveryId }` envelope, so body fields live under `.body`.)

**Security model**

- **Capability URL.** The endpoint token is an unguessable secret; treat the URL itself as a credential — it is not sufficient on its own (URLs leak via logs, history, screenshots).
- **HMAC signature (required by default).** Sign the **raw request body** with HMAC-SHA256 using the endpoint secret and send it as `X-Frink-Signature: sha256=<hex>`. A present-but-invalid signature is always rejected (`401`); a missing signature is rejected when the endpoint requires one.
- **Unsigned opt-out.** If signature verification is turned off for an endpoint, unsigned requests are accepted but the triggered flow is **forced to a non-executing start mode** (it plans, it does not auto-run an agent) — a guard against a leaked URL or an injected payload.
- **Idempotency.** Retries are deduped on the signed body: the same bytes delivered again start nothing new. A delivery-id header is ignored — it sits outside the signature, so it cannot be trusted. One endpoint can drive multiple flows without dedupe collisions.
- **Limits.** Bodies are capped at ~1 MB; only an allowlisted subset of headers (never `authorization`/`cookie`) is forwarded into trigger context.
- **Offline note.** Webhook delivery rides Frink's cloud relay (a stable public URL can't be served from an offline laptop), so webhook-triggered flows need connectivity — same as every other webhook integration.

### manual_trigger

#### Standalone (button click)

When a flow is triggered directly by clicking **Run**, there are no `{{trigger.*}}` fields — the run has no external event data.

#### Batch mode

When the batch engine dispatches a run, the trigger block is **bypassed entirely**. Each `batch_stage_run` carries its own `trigger_context` object set by the CEO agent (the planning agent that builds the batch DAG via `frink_flows_define_stages` — see [Batch execution model](#batch-execution-model)), and that object is what populates `{{trigger.*}}` at runtime — not a real user event.

Common CEO-set fields:

| Field | Example value | Description |
|-------|---------------|-------------|
| `trigger.ticketId` | `"sc-123"` | Shortcut story ID |
| `trigger.label` | `"Navigation & Stepper"` | Human-readable run label shown in the Monitor |
| `trigger.workstreamId` | `"nav"` | Workstream grouping for colour-coding |
| `trigger.customInstructions` | `"Focus on accessibility"` | User-edited override (see [Per-run instructions](#per-run-instructions)) |

The trigger **type** (manual, webhook, cron) has no effect on batch execution. A Manual Trigger block on a batch flow is just a structural entry point — it does not fire, and its type does not restrict what `{{trigger.*}}` fields the CEO can supply.

> **Why the editor may warn:** The flow editor's static validator checks `{{trigger.*}}` references against the trigger type's declared schema. CEO-set fields like `workstreamId` are not in the `manual_trigger` schema, so the editor shows a warning. The warning is a false positive — the fields resolve correctly at runtime when the batch engine injects them.

## `{{loop.*}}` variables

Available only inside nodes contained by a `fan_out`. The canvas shows these blocks inside the **For each item** container.

| Field | Description |
|-------|------------|
| `loop.currentItem` | The current array element (use dot notation for objects: `loop.currentItem.title`) |
| `loop.currentIndex` | Zero-based index of the current iteration |
| `loop.totalCount` | Total number of items being iterated |

## Common patterns

### Run a command and log into the flow chat

You need Start Task (or a post-task flow) before Chat Reply:

```
manual_trigger → start_task → run_command → chat_reply
```

The `chat_reply` can reference `{{previous.exitCode}}` and any JSON fields the command outputs. Without Start Task, use **End** or **HTTP Request** instead of Chat Reply.

### Branch on a command's exit code

```
manual_trigger → run_command → condition (exitCode == 0)
                                 ├── true: start_task → agent
                                 └── false: end   (or http_request — not chat_reply without start_task on this branch)
```

The condition passes through the run_command's outputs, so the agent on the true branch can reference `{{previous.exitCode}}` and any JSON stdout fields. To post a chat message on the false branch, add **Start Task** before **Chat Reply** on that branch (same rule as above).

### Iterate over items

```
manual_trigger → run_command (outputs JSON with "items" array) → fan_out
    ├ For each item: start_task → agent ("Process {{loop.currentItem.name}}") ─┐
    ├ For each item: run_command ("Check {{loop.currentItem.name}}") ──────────┤
    └ After all items: run_command (reads {{previous.results}}) ←──────────────┘
```

The fan_out iterates over `previous.items`. Each iteration gets `{{loop.currentItem}}`, `{{loop.currentIndex}}`, and `{{loop.totalCount}}`.
Connect Fan Out directly to each independent branch root. Branches run concurrently for an item, may contain a linear sequence of steps, and must all end at the same block outside the container. That continuation runs once after every branch for every item and receives `{{previous.results}}` and `{{previous.totalCount}}`. Results are grouped as `results[itemIndex][branchRootNodeId]`.

In **parallel** execution mode, **max parallel lanes** caps concurrent items, while every branch for each active item starts together. Peak branch work is therefore `max parallel lanes × branch count`; extra items run in successive waves. Downstream blocks still see one aggregated `results` array and a `totalCount` matching the full iteration count once the fan_out finishes.

## The Available Variables panel

When you click a block in the Flow Editor, the right panel shows an expandable "Available variables" section. This shows you exactly which `{{previous.*}}`, `{{trigger.*}}`, and `{{loop.*}}` fields are available for that specific block.

- **Clickable chips** — click a variable to copy it to your clipboard
- **Hover for description** — each chip shows what the field contains
- **Dynamic fields note** — when the predecessor is a `run_command` without declared outputs, you'll see a note explaining that additional JSON stdout fields may be available at runtime

## Using flows via the MCP (for agents)

Agents work with flows through two surfaces:

- The **`frink-flows` skill** (`~/.frink/skills/frink-flows/`) provides the knowledge — block types, edge rules, common patterns, custom-node manifest format. The agent reads it on its own when the task involves flows; you don't need to mention it. See [The frink-flows skill](./frink-flows-skill.md) for what's inside, where it ships from, and how to edit it.
- The **`frink_flows_*` MCP tools** mutate and inspect flows. The agent calls these once it knows what to build.

Recommended sequence the agent follows (you don't have to think about it — this is just what's happening under the hood):

1. Skill description triggers when you ask for flow work. The agent reads `SKILL.md`.
2. Agent reads the relevant `references/<topic>.md` files (block types, patterns, custom nodes, edges) as needed.
3. `frink_flows_patch` with `name` + `operations` — create the flow and add the first nodes.
4. `frink_flows_patch` with `flowId` + `operations` — add remaining nodes and configs.

The graph is saved after each patch call, even with incomplete configs. **Run-mode** checks (HTTP URL, webhook integration/event, agent instructions, and other execution requirements) are **not** applied on every patch; they run when you **start** a flow and when the **server creates batch stages** (`frink_flows_define_stages`), which validates the graph in run mode before persisting stages. Template warnings and per-node available variables (`nodeVariables`) are included in every patch response.

### Letting an agent run a flow

A flow's **"Allow agents to run this flow"** setting (Flow settings panel) controls whether an agent may start it — `frink_flows_run` and `frink_flows_start_batch` both need it. It is off for new flows.

You do not have to turn it on in advance. When an agent asks to run a flow without it, Frink shows a card in the chat naming the flow, summarising what it will execute, and (for a batch) how many runs it will start. Choose **Allow once** to run it a single time, or **Always allow this Flow** to turn the setting on permanently. Turning it back off is done here, in Flow settings — it is a property of the flow, not a permission rule, so it does not appear under Settings → Permissions.

Triggers, schedules and runs you start yourself are never gated by this setting, and turning it off does not stop runs already in flight — disable the flow for that.

All stages are created as **`pending`** — execution does not begin until you call `frink_flows_start_batch`. This allows multi-call DAG assembly for large epics (e.g. 144 tickets) without accidentally starting work mid-planning. For **large batches**, use multiple `frink_flows_define_stages` calls (up to 50 stages per call and 50 runs per stage per call, max 20 calls per session, with cross-call `dependsOn` references supported) and `frink_flows_add_stage_runs` (max 50 runs per call, max 20 calls per session) to add runs to any stage while it is still `pending`. Once all stages and runs are planned, call `frink_flows_start_batch` once. Root stages transition to `running`; each eligible run is queued for machine-wide admission and starts when a slot is available. Non-root stages become eligible only after their dependencies complete.

**Flow version during planning:** `frink_flows_define_stages` validates the graph and creates pending stages — it does **not** choose which published flow version will execute. `frink_flows_start_batch` resolves and pins the flow version before it queues the first eligible run; machine admission may leave that run queued without changing its pinned version. Until `start_batch`, the batch is still in the planning window. If you publish graph changes after `frink_flows_define_stages` but before `frink_flows_start_batch`, those edits affect which version runs when the batch starts. To guarantee a specific graph for execution, publish or freeze your final graph **before** `frink_flows_start_batch`.

If `frink_flows_define_stages` returns `success: "partial"`, some stage INSERTs succeeded and others failed. The response includes `failedStages: [{ stageNumber, error }]`. Re-call `frink_flows_define_stages` with the **full run list** for each failed stage number — existing runs for those stages are automatically replaced, so no cleanup is needed before retrying. For any stage that failed mid-definition, the server cancels partial `batch_stage_runs` rows and sets that stage back to **`pending`**, so orphan re-enqueue does not pick up abandoned `queued` rows and the next `define_stages` call can safely retry those stage numbers.

For a concise in-repo reminder (including clearing briefing), see the **Frink Flows** section at the root **`AGENTS.md`** when working inside this repository.

## Machine-wide Flow concurrency

Frink limits the number of top-level Flow runs using machine resources at once. The limit is enabled by default at **4** and can be changed from **Settings → Preferences → Flows** (valid range: 1–20), or disabled for an explicit **Unlimited** state. The setting is local to this machine. Ordinary chats do not count toward it.

When every slot is occupied, another Flow is accepted as **Queued** and starts automatically when capacity becomes available. Lowering the limit never interrupts active work; Frink drains down to the new maximum. Paused runs and runs waiting for approval or a question continue to hold their slot in this release. A queued run does not satisfy a DAG dependency—the successor remains pending until every predecessor actually completes.

Open **Work Queue** to see waiting runs under **Queued to run**. Resumptions always stay ahead of fresh starts. Within either group, drag a row or use its keyboard-accessible **Move up** and **Move down** controls to change which run is admitted next. Reordering queued work never interrupts an active run.

Each row also has a **Remove from queue** control, which takes that work out of the queue rather than stopping anything already underway — if the run was admitted between the panel refreshing and your confirming, Frink reports that it already started and leaves it running. Removing a queued **Starting** row cancels a run that never began; its trigger details cannot be replayed, so re-run the flow to try again, and note that a removed start cannot currently be re-triggered under the same idempotency key. Removing a queued **Resuming** row leaves the finished run exactly as it is, back in **Attention** for a later retry. If the removed run is one member of a batch stage, it counts as a failed member, which can fail that stage and cancel the stages waiting on it.

This outer limit is separate from a Flow's `maxBatchConcurrency`, fan-out limits, and node dispatch behavior. Those controls can further restrict a batch, but cannot raise the machine-wide limit.

## Batch execution model

A **batch** lets you run the same flow many times in parallel, once per item in a list (tickets, files, accounts, etc.). Understanding how the batch engine dispatches runs is key to writing flows that work correctly at scale.

### How runs are dispatched

1. The CEO agent calls `frink_flows_define_stages` to define the DAG: stages, their dependencies, and a list of runs per stage, each with a `triggerContext` object.
2. `frink_flows_start_batch` locks the graph version and transitions root stages to `running`.
3. The signal-bridge (the server component that polls pending runs and fills batch slots) picks up to `maxBatchConcurrency` `batch_stage_run` (BSR) rows and calls `enqueueStageRun(bsr.id, ..., bsr.trigger_context)`.
4. The worker calls `startFlowRun` with `triggerContext = bsr.trigger_context`. This creates a `flow_runs` row and requests machine-wide admission; the run begins at the **first node after the trigger block** once admitted.
5. The trigger block is **never executed** — it is bypassed. The BSR's `trigger_context` is the sole source of `{{trigger.*}}` variables for that run.
6. When all runs in a stage complete, the engine automatically starts the next stage (if its `dependsOn` are satisfied).

### One flow, many runs

Each `batch_stage_run` = one invocation of the **same** flow. Runs in a stage execute concurrently up to `maxBatchConcurrency` and the separate machine-wide Flow limit. Stages themselves execute **sequentially** following the DAG dependency order — a stage only starts after all its `dependsOn` stages have fully completed.

```
Stage A (runs 1-10, concurrent)
    ↓ (all complete)
Stage B (runs 11-20, concurrent)
    ↓ (all complete)
Stage C (runs 21-30, concurrent)
```

Each run sees its own `{{trigger.*}}` context, its own `{{previous.*}}` outputs from block to block, and its own spawned task/worktree. Runs in the same stage do not share state.

### Branch accumulation across stages

When a stage completes, the engine collects the git branches produced by **all** runs in that stage (and all other dependency stages) and injects them into the `trigger_context` of every run in the next stage before it starts. Each successor run receives a worktree that is a merge of all those branches — the Electron client runs `git merge` automatically.

This means successor stages always build on the **complete accumulated work** from every parallel run upstream, not just the most recently completed one.

| Branches collected | What the successor run receives |
|---|---|
| 0 (non-worktree flow) | `trigger_context` unchanged |
| 1 unique branch | `trigger.baseBranch` = that branch, `trigger.baseBranches` = `[branch]` |
| 2+ unique branches | `trigger.baseBranch` = most-recent, `trigger.baseBranches` = all (most-recent first), `trigger.mergeStrategy` = `"most-recent"` |

**Deduplication:** if two node runs within the same flow run carry the same branch string (e.g. Start Task and Agent in one run), only one entry is counted.

**Merge conflicts:** if the automatic merge hits a conflict, the run **pauses awaiting input** — it is not failed. The Monitor's run list marks it "merge conflict — needs input", and the run detail panel shows the conflicting branch and the conflicted files so you can resolve and resume. The conflict is a code conflict, not a DAG failure — other runs in the stage are unaffected.

**The `branch` config on Start Task:** set the `Branch from` field to `{{trigger.baseBranch}}` on any stage that has dependencies. The engine always injects `baseBranches` (even for a single dep branch) so the Electron client uses the dependency branch instead of the static config — but the scalar `{{trigger.baseBranch}}` template still renders correctly for logging or other uses. For root stages (no dependencies), set `baseBranch` explicitly in the `triggerContext` of each run when calling `frink_flows_define_stages` (e.g. `"baseBranch": "feat/my-epic"`); the static config will be used as a final fallback if no `baseBranch` is injected. **Every stage's Start Task also needs `Start in worktree` ticked** (`startInWorktree: true`) — it is off by default (new flows scaffold it on), and a `branch` value alone does not provision a worktree.

**`Start in worktree`:** when off, the agent runs directly against your project's checkout instead of an isolated git worktree — two runs against the same project can then edit the same files at once. New flows have it on by default; leave it off only for a step that intentionally shouldn't touch the filesystem.

### Pull requests for chained stages

A `dependsOn` edge means "**needs the code of**", not just "runs after". A chain of dependent stages is therefore **one line of work** — each stage's branch forks off its dependency's branch, so the last branch in the chain already contains every commit from every stage before it. Stages that don't need each other's code shouldn't be chained at all: make them parallel root stages instead.

That mental model makes the PR story simple — **the PR opens at the leaf**:

- **Intermediate stages** commit and push, nothing more. Pushing matters: the successor's worktree is created from `origin/<branch>`, so unpushed work is invisible downstream. Don't ask an intermediate stage's agent to open a PR.
- **The final (leaf) stage** — or you, manually, once the batch finishes — opens the **single PR** for the whole chain. No draft PRs, no rebasing, no waiting between stages: the leaf branch is the accumulated result.
- **Independent tickets** run as parallel root stages, and each opens its own PR.
- **Converging stages** (a stage with 2+ dependencies) get a fresh branch that is the merge of all dependency branches — so the converged leaf's PR carries the work of every path through the diamond.

If a middle chunk of a chain genuinely needs early human review, stacked per-stage draft PRs are possible as a manual pattern (each PR targets its dependency's branch; merge bottom-up; use merge commits, not squash, or the stack breaks). It's real upkeep — reach for it only when mid-chain review is actually required.

### Trigger type is irrelevant in batch context

The trigger block's type (manual, webhook, cron) only matters for **standalone** execution (clicking Run, a cron firing, etc.). In batch context, the batch engine bypasses the trigger entirely. A Manual Trigger block on a batch flow is simply a structural entry point and schema declaration; at runtime, each run's `trigger_context` from the CEO plan provides all `{{trigger.*}}` data.

### Per-run instructions

Each `batch_stage_run` can carry a `customInstructions` field in its `trigger_context`. This becomes `{{trigger.customInstructions}}` in your agent instructions — a user-editable override that applies only to that run.

Add it via the Monitor → click a run → **Add instructions**. Only reference it in agent instructions if you actually want user overrides to be honoured:

```
Implement the story. {{trigger.customInstructions}}
```

If `customInstructions` is empty for a run, the placeholder resolves to an empty string and no extra text is injected.

**Note:** Most `{{trigger.*}}` fields (like `ticketId`, `label`, `workstreamId`) are set by the CEO agent when planning the batch, not via this UI. `customInstructions` is the one field designed for user-level per-run overrides.

### Declared batch variables vs run `trigger_context`

**Declared** rows under Flow Settings → Batch trigger variables are design-time only: they control editor chips and template validation, not injected values. At execution time, `{{trigger.*}}` is filled only from that run’s stored `trigger_context` (CEO `triggerContext` per run, plus engine-injected branch fields on dependent stages). **From runs** shows keys that have appeared on real `batch_stage_run` rows — another run in the same batch can still omit a key, which renders that placeholder as an empty string for that run only.

### Re-running a terminal batch

Recovery is per member, from that member's chat, with the same **Retry** and **Carry on** every flow has: Retry re-runs the member from its last step through the normal run queue and re-opens its stage; Carry on resumes a paused member's session in place. A member whose stage has already settled — completed on a tolerated failure, or cancelled — can't be retried, and the button says so: the batch has moved on. A stage that is at its concurrency limit makes a retry wait for a member to finish. Successor stages the failure had cancelled run again once the retried member completes its stage. There is no whole-batch "retry everything" action; the Flow editor's run button only starts a batch that has never run. Restart-interrupted members, like other runs, continue on their own after a restart (see *Restart recovery*).

## Pausing and stopping a flow from the chat

While a flow run is actively driving a chat, the message box is replaced by a **status strip**. It reads top to bottom: a quiet line of context chips, then the step that's running alongside its controls, then the note box when you open one.

The context chips show what the running step is configured with — its **mode** (Agent, Plan, Debug), its **model**, **Auto on** / **Auto off** when the step's provider can auto-review approval requests, and **Fast** with its credit multiplier when the step is running on Codex's priority tier. Fast appears only while it is on and only on a model that offers the tier, because its job is to tell you the run is spending at a higher rate — there is no "Fast off" chip, and a step whose model has no priority tier shows nothing rather than a chip claiming a cost you are not being charged. Auto is shown only where it can actually apply: a step that is still planning, or on a provider with no reviewer of its own, shows no Auto chip rather than a chip explaining that it doesn't apply. An auto-approved Plan step is the case where that changes mid-step — once it submits its plan it switches to **Agent** and its Auto chip appears alongside, because from that point it is implementing rather than planning. On a narrow pane the chips drop their words and keep their icons (hover for the full text), and between steps, where there is nothing to report, the whole line disappears.

The controls line carries up to three:

- **Pause** — stops the current step immediately (no more tokens spent) and parks the run. The chat switches to a **paused bar** where you can type new instructions, press **Resume** to continue where it left off, or **Stop**. Pause only appears while an **agent step** is actually running, since that is what it stops: between two steps, or while a non-agent step (a command, an HTTP call) is doing the work, the strip shows **Stop** and **Add a note** only. Batch members pause the same way: the member's stage simply waits for it, and the Batch Monitor marks it **needs input** until you resume.
- **Stop** — cancels the run for good, behind a confirm click. Unlike Pause, a stopped run can't be resumed.
- **Add a note** — send the agent a message without interrupting it. The running step finishes whatever tool call it is in the middle of, then picks your note up at its next thinking step, so nothing it had already done is thrown away. If the step cannot take the note right then — it is waiting on a permission prompt, or the runtime has no way to reach a running turn — the note goes to the visible message queue instead and is delivered when the step finishes; there you can still edit or remove it. The note box opens full-width beneath the strip, and the **Add a note** button steps out of the way while it's open, since the box itself is the invitation. Press the **✕** beside the send button to discard what you've typed, or **Escape** to just close the box and keep it; either way the button comes back with the keyboard focus on it. An unsent note survives the strip being swapped out (a park, or the step changing) and the box reopens with it still there.

**Stop** always sits at the far right of the controls, and nothing that comes and goes is allowed to move it — so a click never lands on the wrong control because Pause disappeared or the note box opened.

When the run parks with a question (Awaiting Input), the strip gives way to the **answer surface**: clickable options when the agent offered them, otherwise the agent's ask with a reply box. Answering resumes the run in place. When the run finishes (or you stop it), the normal message box returns.

While a flow chat shows the strip, the keyboard stop shortcuts (Escape, Ctrl+C) are disabled — use the strip's deliberate Pause/Stop instead, so a stray keypress can't kill a long run.

In the **Runs** tab, a step waiting on a question shows an **Answer** button that jumps you to the chat (Retry/Skip remain for failed or blocked steps).

## Run history and the canvas overlay

Node borders and badges on the flow canvas show **execution state for one run at a time**. The editor header labels that run (e.g. **Live** with a start time, **Viewing run from …** when inspecting history, or **Completed / Failed · …** after a finished run).

A step that parks at **Awaiting Input** or **Blocked** paints its canvas node with an **amber border** (dashed for Blocked) instead of the running pulse — a waiting flow no longer looks like a working one.

Open **Runs**, expand a finished or failed run to paint its step statuses on the canvas. Expanding a **running** or **paused** run does not replace the live overlay.

Collapsing a row you opened from history clears the historical canvas overlay.

**Clear** invokes `clearOverlay()` in the editor: it hides node borders and badges on the canvas immediately. **For historical or idle overlays** (no active run driving the canvas—e.g. you finished inspecting a past run, or nothing is running), that hide is **complete**—the overlay stays gone until you open another run from history or start a new execution. **For live runs** (**running** or **paused**), `clearOverlay()` is only **temporary**: the next socket execution event for that run will repaint borders and badges, so the overlay **reappears**. In short: for historical/idle overlays, Clear removes the overlay entirely; for live runs, Clear is temporary.

## Monitor image uploads

In the **Monitor**, you can attach images (screenshots, references, etc.) to a run via the **Images** panel in the run detail view. Images are only accepted for runs in **pending** status — once a run starts, the upload controls are hidden.

**Supported formats:** PNG, JPEG, WebP  
**Size limit:** 5MB per image, maximum 10 images per run

**"Run has started…" message:** If you begin uploading an image just as the batch starts dispatching that run, the server detects the conflict and shows `Run has started and images can no longer be added`. The run itself is unaffected — the image was not saved.

**"Upload failed" message:** Usually a transient network or storage error. Retry by adding the image again.

**Image privacy:** Uploaded images are stored privately and served through the Frink backend with your authentication. They are not publicly accessible — only you can retrieve them via the authenticated API. Images cannot be opened directly in a browser.

## Failure handling

By default, when a node fails (agent signals `failed`, dispatch error, or timeout), the flow run terminates immediately with `status = 'failed'`. All in-progress state is discarded.

### maxBatchConcurrency

Limits how many runs from this batch can be queued or dispatched at the same time. By default up to 5 occupy the batch allowance. The machine-wide Flow limit is a separate outer cap.

Valid range: 1–20. Set via MCP:

```
frink_flows_patch({
  flowId: "<id>",
  operations: [{ op: "update_settings", settings: { maxBatchConcurrency: 3 } }]
})
```

**Use case:** Running multiple flows in parallel and you want each batch to submit fewer runs at once so others aren't starved.

### pauseOnFailure

Enable **Pause on failure** in the Flow Settings panel to change this behaviour. When enabled:

- The flow pauses (`status = 'paused'`) instead of terminating
- All state — KV store, pending downstream nodes — is preserved in Postgres
- The failed node is highlighted in the run history
- You can **retry** or **skip** the failed node to resume the flow

**Where to enable:** Flow Editor → open **Settings** (toolbar) → toggle **Pause on failure**.

You can also set it via MCP:

```
frink_flows_patch({
  flowId: "<id>",
  operations: [{ op: "update_settings", settings: { pauseOnFailure: true } }]
})
```

### autoAcceptCompletedRuns

When **off** (the default), a successful run's tasks land in **Ready for review** — they wait there until you accept them (in-chat bar, work queue, or sidebar menu; see the Task Lifecycle guide). When **on**, a successful run finalizes its tasks straight to **Completed** with no review gate — useful for trusted automations (e.g. nightly triage) that should close themselves.

Failed and cancelled runs are never auto-accepted, regardless of this setting.

**Where to enable:** Flow Editor → open **Settings** (toolbar) → toggle **Auto-accept completed runs**.

You can also set it via MCP:

```
frink_flows_patch({
  flowId: "<id>",
  operations: [{ op: "update_settings", settings: { autoAcceptCompletedRuns: true } }]
})
```

> Note: honored by the flow engine, which runs every flow on your machine.

### Fast mode (Codex)

**Fast mode** asks Codex for its **priority** service tier on this flow's Agent steps. For ChatGPT-authenticated Codex it provides **1.5× model speed** and uses **2.5× ChatGPT credits** on GPT-6 Astra, Sol and Luna, GPT-5.6 and GPT-5.5 or **2× ChatGPT credits** on GPT-5.4. API-key priority pricing is separate and may differ. It is **off** unless you turn it on, and the Settings panel labels speed and credit use separately for the flow's default model.

It applies only to Codex models that advertise the tier; steps on any other model — including GPT-5.4 Mini and Claude — run normally and are unaffected. Direct command and custom-node steps are unaffected too.

The setting is flow-wide, deliberately: there is no per-step override, so a flow's spending rate stays readable from one place instead of hiding in an individual node. While a run is driving a chat, the status strip's **Fast** chip shows it is active (see the status strip section above) — the chat's own Fast switch is hidden behind the run surface at that point.

**Where to enable:** Flow Editor → open **Settings** (toolbar) → toggle **Fast mode**.

```
frink_flows_patch({
  flowId: "<id>",
  operations: [{ op: "update_settings", settings: { codexFastMode: true } }]
})
```

### Retry and Skip

When a flow is paused on failure, expand the run in the **Run history** panel. Each failed node shows two buttons:

- **Retry** — re-dispatches the node from scratch (increments attempt count, preserves fan-out state so iteration position is maintained). Use this when the failure was transient (network blip, machine offline, rate limit).
- **Skip** — marks the node as skipped and advances the flow as if the node completed with no outputs. Downstream `{{previous.*}}` references will resolve to empty. Use this when the step is non-critical and you want the flow to continue regardless.

### Carry on and Retry in the agent's chat

A failed or parked task shows one recovery row with two controls, under the last response. Read the pair as **"continue" vs "start over"**:

- **Carry on** — continues the resumed agent session in the same chat and worktree; the agent picks up from where it left off, so finished work is never redone and nothing is rolled back. If in doubt and it's available, carry on.
- **Retry** — for a **standalone task**, this is the "start over" option: a fresh session, behind a confirmation that spells out what is abandoned. For a **Flow run**, Retry is gentler: it re-enters Flow admission and retries the last invoked step *continuation-first* — a surviving session picks up with its prior work, todo state, and current mode intact (no repeated instructions, no reset back to plan mode); only a step with nothing left to continue is re-run from its full instructions.

**For a Flow task the two are never active together.** The run's state picks the live control — a *paused* run that still holds its admission slot offers **Carry on**; a *settled* run (failed, cancelled, or completed), whose slot is gone, offers **Retry** — and the other button's tooltip explains why it's disabled. Only a failed *standalone* task genuinely offers both at once, where they mean continue vs start over. Want a deliberate clean re-run of a Flow step regardless of whether its session survived? That's **Re-run step** / **Re-run from previous node** in the Flow surfaces, which always restart from the instructions.

Work Queue opens the Flow chat for these slot-sensitive actions rather than duplicating Carry on. Both controls work for batch members too: a retried member re-enters the run queue and its stage, subject to the stage's concurrency limit (see *Re-running a terminal batch*).

### Usage-limit and API-error pauses

A flow can also pause without anything failing: if an agent node's chat hits the provider's usage limit (e.g. Claude's "You've hit your limit · resets 2:20pm"), the node parks at **Needs Attention** and the run pauses rather than failing — the interruption is resumable, not an error. The run panel shows the limit message (including the reset time) as the pause reason, with the same Retry/Skip controls. Once the limit resets, resume by sending a follow-up message in the agent's chat or pressing **Retry** on the node.

Transient provider errors get the same treatment: an authentication error (expired token), rate limit (429), or a temporary server error (5xx/529) first retries once automatically — when the turn had produced no work yet — and otherwise parks the node at **Needs Attention** with the error as the pause reason. Fix the cause if needed (e.g. reconnect the account in Settings → AI providers for an auth error) and press **Retry** to continue where it stopped. Batch members park the same way and their stage waits for them; reply in the member's chat, or press **Retry** / **Carry on**, exactly as for any flow.

### Quiet waits and the idle ceiling

An agent step sometimes goes quiet on purpose — it kicked off a long command or a background
helper (a test suite, a slow build) and is waiting for the result. Silence is not completion: the
run keeps showing **running**, and nothing is marked done or parked while the agent may still be
waiting. If a step then shows **no activity for 45 minutes**, it parks at **Needs Attention** with
a "run went quiet" note — reply in the agent's chat to resume it, or stop the run. If the agent's
background work then finishes and the agent wakes on its own, the park lifts automatically and the
step shows **running** again. Batch members park the same way: the waiting member's row in the
Batch Monitor reads **needs input**, and its stage reads **blocked** once every started member is
waiting on you.

### Agent questions pause the flow

When an agent inside a flow needs your input — a decision, a missing detail — it parks the node at **Needs Attention** (an `awaiting_input` signal), just like the pauses above. It never opens a blocking pop-up, so an **unattended** flow waits cleanly for you instead of stalling. If the agent offered choices, you'll see **clickable options** — in the agent's chat, or via the **Answer →** button on the work-queue card. Pick one (or type a free-form reply) to resume the node. See the Task Lifecycle guide for the full answering flow.

### Durability

Paused flows wait indefinitely. There is no timeout. State persists across:

- Server restarts
- Electron going offline
- Machine reboots

When the system comes back up, the paused flow is still there. Open run history and retry or skip to continue.

### Restart recovery

A single recoverable renderer-only crash is handled before restart recovery is needed: Frink reloads the window while a main-owned Claude step continues, then restores its live output, Stop control, questions, permission or move-chat prompts, and any wake hold before acknowledging the new window. This does not cover a main-process exit, app quit, machine restart or repeated renderer failure. If the renderer cannot be restored safely, Frink stops the step visibly and the interruption path below applies.

On macOS, closing Frink's window without quitting the app leaves a main-owned step running; opening a new window re-observes it. Quitting the app or intentionally hard-reloading the window still interrupts the step.

If the app or machine restarts (or a window reloads) while a flow's agent is mid-run, that run is marked **cancelled** with a recovery marker — a restart is treated as a recoverable interruption, not a failure, so it never surfaces an alarming red badge. The work up to the interrupted node (its worktree and the prior nodes' outputs) survives on the same run.

**Finding one.** Interrupted runs appear under **Active → Needs attention** in the work queue, marked *Interrupted* — the same place you look for any run waiting on you, alongside runs paused for your input. They are deliberately kept out of History: an interrupted run is work still waiting on you, not a finished record, and History is where you would never look for it. Opening the card takes you to the run's chat, where you resume it. An interrupted run stays in Needs attention until you resume it — or, if you'd rather abandon it, delete its chat: that clears the run from the work queue while keeping it under **Flows → Runs** history. (Before this existed, an interrupted run sat in History labelled "Cancelled" and was only reachable if you already knew which chat it was.) A run interrupted inside a **parallel/fan-out step** is the one exception — those can't be resumed, so they stay in History as *Cancelled*, same as before.

**Continuing automatically.** After an app restart, Frink carries interrupted agent steps on by itself whenever it safely can: if the agent's session survived, the run re-enters the run queue as a resumption — ahead of any fresh starts that were waiting — and the agent wakes up where it stopped, in the same chat and worktree (a tool call that was cut off mid-flight may run again — the same as pressing Carry on yourself). While it waits for a free slot the chat shows *Waiting for a free slot to resume this step* instead of a button; cancelling the run from the work queue during that wait still works and stops the resumption. Steps that can't be continued this way (no surviving session, a non-agent step, a batch member whose stage already settled, a parallel/fan-out lane) stay *Interrupted* and wait for you, as below.

**Continuing one by hand.** In the flow's chat, a button appears just above the message box, next to a "Flow run interrupted" note. It reads one of two ways, depending on what can actually be recovered:

- **Re-run step** — offered whenever Resume can't be: the agent's session is gone, *or* the run lost its place in the run queue. The step restarts from its instructions in the same worktree — the run re-enters the run queue properly first, so it can't collide with the concurrency limit. You'll see the step's prompt in the chat again, and any work the step already did may happen again.
- **Resume** — offered when the interrupted agent's session survives *and* the run still holds its place in the run queue (in practice: the interruption was caught before the run's slot was released). The agent simply wakes up and carries on in the same chat and worktree, with nothing repeated. Sending a follow-up message does the same thing here, and lets you add new instructions while you're at it.

Either way, typing into the chat is never a dead end — and when the run has *lost* its place in the queue but its session survived (the usual case a while after a restart), typing is the better option: the button above reads **Re-run step** and would repeat the step from its instructions, but a typed message instead re-enters the run queue and *continues* the surviving session with your message, nothing repeated. Only when no session survived at all does a typed message get a "This flow run has ended" notice pointing you to **Re-run step**.

The **Re-run from previous node** button in the run-history panel always re-runs from instructions, whichever behaviour the chat offers.

A run you stopped yourself — the **Stop** button, or deleting/archiving the chat — carries no recovery marker, so it shows no button at all; start a fresh run instead.

> Re-running a node that already made changes (a `run_command` step, an HTTP request) runs those side effects again. Recovery is manual and deliberate for that reason.

### Retry-fail cycle

If a retried node fails again and `pauseOnFailure` is still enabled, the flow pauses again. You can retry as many times as needed.

### Not yet available

A **Continue** (override) action — advancing the flow with user-supplied synthetic outputs — is deferred to a follow-up. It requires UX design for providing override data safely.

## Tips

- **Use Flow briefing** when many Agent steps should share one PRD or ruleset — set it once in Settings instead of duplicating text on every node. It reaches every agent automatically (delivered as a system prompt), so you don't reference it in instructions.
- **Always check the Available Variables panel** before writing template expressions. It shows you exactly what's available for the selected block.
- **Use `expectedOutputs`** on `run_command` nodes that output JSON. This is the single biggest improvement you can make for flow reliability.
- **Remember the one-hop rule.** If you need data from a block that's two or more steps back, you either need to route through `condition` nodes (which pass through) or re-compute the data.
- **Validate before saving.** The validator catches structural issues (including Chat Reply without a chat source) and template variable references that won't resolve — use it.
- **Keep stdout clean.** If your `run_command` outputs JSON, make sure no other text (logs, warnings) is printed to stdout. Redirect noise to stderr: `my-command 2>/dev/null` or use `2>&1 >/dev/null` selectively.
- **Condition is your friend.** When you need to branch AND preserve upstream data, condition is the only way. It's the only block that doesn't replace the previous outputs.
