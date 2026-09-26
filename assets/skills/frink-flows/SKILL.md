---
name: frink-flows
description: Design, edit, validate, and inspect Frink Flows and batch stages. Read before frink_flows_patch, frink_flows_define_stages, or frink_register_node.
---

# Frink Flows

A Flow is a graph: one trigger starts action/logic nodes connected by edges. Use MCP tools for live state and changes; this skill explains the contracts. Do not edit flow YAML on disk.

## Authoring workflow

1. For an existing flow, read it with `frink_flows_get` (discover with `frink_flows_list`). Discover projects, integrations, commands and installed nodes with `frink_flows_list_catalog`; use returned ids/names.
2. Choose the trigger and required blocks. Every Agent needs an upstream Start Task (a session; see [Sessions](#sessions-start-task)); Chat Reply needs upstream Start Task or Post-Task trigger chat context.
3. Wire data deliberately: `trigger.*` lasts the run, `previous.*` is one hop, `loop.*` lasts the fan-out body. Only Condition passes predecessor data through; Start Task and Agent replace it.
4. Save via `frink_flows_patch`. Create with `name` and no flowId; modify with `flowId`. Read returned errors/warnings and correct the cause. Save checks topology; run/define_stages also check execution config.
5. Run only within the user's requested scope; inspect the returned run id with `frink_flows_get_run`. Batch work follows plan → user confirmation → define → start.

## Graph and patch essentials

- Exactly one trigger, ≤50 nodes, unique node/edge ids; edges reference existing ids. Prefer lowercase-hyphen ids. End has no outgoing edges.
- Edge: `{ "id":"e1", "source":"a", "target":"b" }`. Condition requires true/false sourceHandle branches. Fan-out uses contained linear branches and a shared continuation; read its contract before wiring.
- Nodes may omit `position` for auto-layout; if supplied, use roughly 200px vertical / 300px horizontal spacing.
- Patch operations: add/remove/update node or edge, and `update_settings`. `update_node.config` merges recursively (JSON Merge Patch); null removes a key.
- Create `projectId` seeds `settings.defaultProjectId` (otherwise current session project when resolvable). Nodes inherit it; Start Task may set config.projectId explicitly.
- Fan-out continuation receives `previous.results[itemIndex][branchRootNodeId]` plus totalCount. Generic convergence outside it is OR, not an all-predecessors barrier.

## Sessions (Start Task)

Each Start Task that runs opens a sidebar chat (plus a worktree when `startInWorktree`) — on every run, so a schedule multiplies it. Every later Agent and Chat Reply continues that chat.

- Default to ONE Start Task per flow. Place it before the first node whose output a later block needs (Start Task replaces predecessor data); if most runs exit at a gate, place it after the gate and have agents read `trigger.*` or re-read data.
- Fan-out body agents with no Start Task of their own continue the session opened before the fan-out.
- Add another Start Task only for a different project, a separate branch that becomes its own PR, per-item isolated context or clean tree (a shared session is one conversation and one tree), or when the user asked for separate chats.
- A Start Task inside a fan-out opens one chat (and worktree) per item, every run.
- Never add a Start Task just to hold a report; reply in the session that did the work.

## Read only what the task needs

All paths are bundled relative to this file; no source checkout is needed. Config and generated output fields are colocated in the block guides.

| Task | Reference |
|---|---|
| Choose/configure trigger and its data | [Trigger contracts](references/blocks-triggers.md) |
| Bind friendly webhook fields | [Provider aliases](references/webhook-aliases.md) |
| Create tasks/agents, run commands, call HTTP/integrations, reply in text/HTML | [Action contracts](references/blocks-actions.md) |
| Wire condition, fan-out, approval or end | [Graph and logic](references/blocks-logic.md) |
| Carry data between blocks; templates and shared briefing | [Templates and context](references/template-variables.md) |
| Start from a complete validated patch or common pattern | [Examples](references/examples.md) |
| Plan many tickets, stages, dependencies, branches and concurrency | [Batch orchestration](references/batching.md) |
| Run, inspect, diagnose pauses/failures | [Run inspection](references/inspecting-runs.md) |
| Register/test a custom block, including multi-file packages | [Custom nodes](references/custom-nodes.md) |
