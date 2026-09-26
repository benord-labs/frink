# Permissions

Frink controls what your AI assistant can do on your machine — read which files, run which shell commands, call which MCP tools. The permission system sits between every tool the agent wants to use and the actual operation, asking you the first time and remembering your decision.

This guide explains how rules are shaped, how they're scoped, and how to write your own from the Settings → Permissions page.

## The short version

- The agent asks before doing anything new. You see a prompt with Deny / Allow once / Allow {tool} for {project}.
- Click "Allow Read for frink" once and the agent can read files inside frink from now on. Other projects on your machine are unaffected.
- Open Settings → Permissions to see, edit, or hand-craft rules. Power-user grammar like `Bash(npm:*)` or `Edit(src/**)` lives here.
- A built-in deny list covers credential paths (`.env`, `.ssh/`, `.aws/`, `~/.gnupg`, etc.) on the surfaces Frink gates; no rule you write can override it. It is a static check, not a sandbox — [What's always blocked](#whats-always-blocked-system-deny-list) states its exact coverage and current limits.

## The three scopes

Every permission rule lives in one of three scopes. The scope determines when the rule fires.

| Scope | Where it stores | When it fires |
|---|---|---|
| **Policy** | `/etc/frink/managed-permissions.json` (macOS / Linux), `C:\ProgramData\frink\managed-permissions.json` (Windows) | Always. Managed by an admin; read-only inside the app. |
| **Project** | Frink's local SQLite, keyed by project ID | Only when the chat's active project matches |
| **User** | Frink's local SQLite, keyed by your machine user | Always, on this machine. Not synced to other machines. |

When the agent makes a tool call, Frink evaluates rules in order: **deny in any scope wins absolutely**, then `policy > project > user` for allow / ask. Miss in all three → prompt.

**Your saved "allow" decisions start over once.** Permission rules belong to this computer, so Frink clears the allow rules it was holding rather than hand this machine an approval it cannot show you gave here — that is the safe direction, because a wrong deny only costs you a click and a wrong allow does not. Your deny and ask rules are kept. The agent asks again the first time it needs something, and one click stores it for good.

## Rule grammar

A rule is a string. Two shapes:

```
ToolName                  ← "tool-wide": match any input for that tool
ToolName(content)         ← match only when the input matches "content"
```

`content` semantics depend on the tool. Examples:

| Rule | Effect |
|---|---|
| `Read` | Allow any Read call |
| `Edit(src/**)` | Allow Edit on any file under `src/` (glob, picomatch grammar) |
| `Read(/etc/hosts)` | Allow Read on exactly `/etc/hosts` (absolute path) |
| `Bash` | Allow any Bash call (broad — usually not what you want) |
| `Bash(npm:*)` | Allow any `npm <anything>` invocation |
| `Bash(git push:*)` | Allow `git push <anything>` but not `git pull` |
| `Bash(rm -rf:*)` | Match any `rm -rf <anything>` (useful for `deny` rules) |
| `mcp__shortcut__*` | Allow any tool on the `shortcut` MCP server |
| `mcp__shortcut__create_story` | Allow exactly that one MCP tool |

Parens in `content` must be escaped with backslash: `Bash(node -e "console.log\(1\)")`.

## Tool names

Tool names are **case-sensitive**. `Read` works; `read` and `READ` do not. If you mistype the case, Settings will catch it and suggest the right one.

Built-in tools Frink recognises:

| Tool | Operation | What it does |
|---|---|---|
| `Read` | read | Read a file's contents |
| `Glob` | read | Find files by pattern (always allowed — not rule-governed) |
| `Grep` | read | Search file contents (always allowed — not rule-governed) |
| `WebFetch` | read | Fetch a URL |
| `WebSearch` | read | Run a web search |
| `Edit` | write | Edit an existing file |
| `Write` | write | Create or overwrite a file |
| `MultiEdit` | write | Multiple edits to one file in one go |
| `NotebookEdit` | write | Edit a Jupyter notebook |
| `Bash` | write | Run a shell command |
| `Task` | write | Dispatch a subagent |
| `TodoWrite` | write | Track agent todos |
| `ExitPlanMode` | write | Transition from plan mode to execute |
| `Delete` | delete | Delete a file |

MCP tools (`mcp__server__tool`) are open — any name matching the `mcp__` prefix is accepted because the MCP server universe is open by design.

## Rule types

Every rule is one of:

- **allow** — proceed without prompting
- **deny** — block, no prompt
- **ask** — always prompt the user, even after an earlier allow

Deny wins over allow if both match the same tool call.

### Tools you can't deny

A short list of tools is required for the agent to function correctly. You can `allow` or `ask` them, but `deny` is blocked at the input layer:

- `ExitPlanMode` — denying it strands the agent in plan mode forever
- `TodoWrite` — denying it silently breaks the agent's internal task tracking
- `Task` — denying it disables subagent dispatch entirely

If you want a prompt every time one of these fires, use `ask` instead.

## How a prompt becomes a rule

When the agent tries a tool with no matching rule, you'll see a prompt. The shape depends on the tool:

**File operations** (Read / Edit / Write / Delete / MultiEdit / NotebookEdit):

> **Allow Read in frink?**
> `src/main/index.ts`
> [Deny] [Allow once] [Allow Read for frink]

Click "Allow Read for frink" and Frink stores a tool-wide rule `Read` at this project's scope. The agent can read any file inside the project going forward. Reads in other projects still prompt.

If the file is outside the current project (e.g. `~/Desktop/other-project/foo.ts`), the "Allow Read for frink" button disappears — only Deny / Allow once. Project-scope rules wouldn't apply outside the project anyway.

**Bash, MCP, generic tools**: the prompt shows a dropdown of suggested rule shapes (`Bash(npm test:*)`, `Bash(npm:*)`, exact command, etc.) and four buttons including "Allow on machine" for user-scope.

A command Frink cannot describe with a reusable rule — one built from a shell expansion, a substitution, or an `eval`-style command — is offered only as its exact text (`echo $(date)` becomes `Bash(echo $\(date\))`, since parentheses are escaped in a rule), because a `Bash(echo:*)` rule would also cover commands you never saw. A deny rule you wrote still applies to these. In the rare case where no rule could match the command at all, the "Always allow" row is hidden and you get Allow once / Deny only, rather than a button that silently remembers nothing.

**Letting an agent run a Flow** is the one prompt that is not about a tool, so it does not become a rule:

> **Let this chat's agent run "Nightly digest"?**
> 3 steps · manual_trigger, agent — Runs commands on this machine (agent)
> [Deny] [Always allow this Flow] [Allow once]

The card names the flow and summarises what it will execute, because a flow's name is chosen by the agent that wrote it. "Allow once" runs it a single time and stores nothing. "Always allow this Flow" turns on that flow's **"Allow agents to run this flow"** setting — it is a property of the flow, not a permission rule, so it will **not** appear under Settings → Permissions. Turn it back off in the Flow's own settings panel.

Starting a batch shows the same card with the number of runs it will start, so a single click can never authorise more work than you were shown.

## Writing rules by hand

Settings → Permissions has an **Add rule** field at the bottom of each scope card. Type a rule and a type (allow / deny / ask), click Add.

| What you want | Type this |
|---|---|
| Allow all reads in the project | `Read` |
| Allow Edit only inside `src/` | `Edit(src/**)` |
| Allow any `git` invocation | `Bash(git:*)` |
| Block any deletion of `.lock` files | `Bash(rm:*.lock)` (type: deny) |
| Allow Shortcut MCP across the board | `mcp__shortcut__*` |

The validator surfaces errors inline:

- Unknown tool: "Unknown tool `xyz`. Recognised tools: …"
- Wrong case: "Did you mean `Read`? Tool names are case-sensitive."
- Required-tool deny: explained above.
- Grammar issue: e.g. unmatched paren.

## What's always blocked (system deny list)

No rule you write can open up these paths. This is a static deny list, not a sandbox — it applies where Frink gates and inspects: file writes/edits, Claude `Read`s, Codex command/patch/terminal input, and commands whose path arguments Frink's classifier resolves (a command it can't statically resolve — an unlisted binary, `git diff --no-index`, a path made relative by an earlier `cd` — falls back to the ordinary ask prompt instead of a hard deny). Not covered today: Codex file reads, MCP operation arguments, plus the `Glob`/`Grep` search tools on every provider. OS-level sandboxing to close these structurally is the planned follow-up. The list:

- `**/.ssh/**` — SSH keys + known_hosts
- `**/.aws/**` — AWS credentials
- `**/.gnupg/**` — GPG keys
- `**/.config/gcloud/**` — Google Cloud credentials
- `**/.gitconfig`, `**/.git/config` — Git config (may contain tokens)
- `**/.env`, `**/.env.*` — Environment files (likely secrets)
- `**/credentials.json`, `**/secrets.*` — Generic secrets
- `**/*.pem`, `**/*.key` — Private keys
- `**/id_rsa*`, `**/id_ed25519*` — SSH key pairs

`.env.example` is allowed (templates, no secrets). Symlink targets resolve through and obey the deny list — you can't sidestep it with a redirect.

## Pasted text auto-allow

When you paste a large block of text into the chat, Frink writes it to a per-chat scratch file under `~/Library/Application Support/.../claude-sessions/<chatId>/pasted/`. The agent then reads that file. This Read is auto-allowed — you don't see a prompt because you already approved the content by pasting it.

The auto-allow is scoped to the current chat's directory and runs after the system deny list. Other chats' pastes don't bleed across.

## Skills auto-allow

Frink-shipped skills (e.g. `frink-flows`) are **first-party assets Frink writes and maintains**, so the agent **reading** one is auto-allowed — no "external path" prompt. Frink installs them as **real copies** into each tool's skills dir (`~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills`) from the canonical `~/.frink/skills/`, and they carry a `.baseline.json` marker — that marker, not the location, is what grants the auto-allow.

Your **own** skills follow you across tools too: Frink projects them (real copies) into each tool's skills dir when you spawn an agent. But because they're **yours, not first-party**, the agent reading one still prompts the first time — allow it once (or add a `Read` rule) and you're set. Anything copied in from another tool is treated the same way: it runs through your approval because Frink didn't author it.

The auto-allow is **Read-only** (editing or writing a skill file always prompts) and runs **after** the system deny list — a secret smuggled into a skills dir (e.g. a `.env`) is still blocked.

## Plugin tools

When you connect a plugin, your agents get that provider’s tools. They are not auto-allowed: they are reviewed exactly like any other tool. With **Auto permission mode** on, the active provider’s reviewer decides each call. With it off, a tool asks you the first time and you can choose "always allow" so it stops asking.

An **unattended flow** (triggered by a webhook, with nobody watching) would otherwise stall on that question. Two things prevent it: **Flow settings → Auto Mode** is on by default, so the flow’s agent steps run under the provider's reviewer; or you can add an allow rule for the tools that flow needs.

## Auto permission mode

Normally, a tool call that needs approval asks you. **Auto permission mode** delegates eligible approval requests to the active provider’s built-in AI reviewer: Claude Code Auto Mode for Claude, or Codex auto-review for Codex. Frink does not run a second home-grown judging model.

Auto is a **per-chat** setting, and it is always yours to change. Its permanent **Auto** control sits beside the chat mode selector in the composer. New chats start off; the choice you make before sending is saved to that newly created chat. When Auto cannot run — for example with an unsupported provider or model, or before your account has been checked — the same control stays visible as **Auto unavailable** and explains why. A project is not required: Auto works in a general chat too, where the folder it works in is your home folder. Plan mode is not one of those cases — Auto reviews the planning phase too: see **Auto in Plan mode** below.

Flows own their own setting in **Flow settings → Auto Mode**. It defaults on, including for existing flows that do not yet store a value, and it does not affect direct command or custom-node steps. When a Flow dispatches an Agent step into a chat, **it sets that chat’s Auto control to the Flow’s value** — so the whole chat runs the way the Flow does: the dispatched step, your answers to its questions, a Resume, and any reply you type yourself. While a run is on screen the readout above the input shows which way Auto is set. The Flow re-applies its value each time it dispatches another step, so a change you make mid-run holds only until the Flow’s next step; once the run finishes the setting stays where the Flow left it until you change it. There is no application-wide Auto master switch.

Auto changes who reviews an eligible request; it does not remove the surrounding controls:

- Claude and Codex keep their provider sandbox and managed policies.
- Frink’s explicit permission allows and denies are applied before Claude’s reviewer. Server authorization remains enforced.
- Auto covers every tool type the same way — Bash, file operations, MCP tools, and Frink’s own flow tools. With Auto on, an eligible request never raises a manual prompt; with Auto off, flow writes and other MCP tools ask through the standard prompt with “always allow” options.
- One exception: letting an agent **run** a Flow is a decision about that Flow, not about a tool, so it always asks you. With Auto on the card still appears and the run does not start until you answer — the agent is told the approval is pending rather than being left waiting. Turning on “Allow agents to run this flow” in Flow settings, or choosing “Always allow this Flow” on the card, stops it asking again.
- A reviewer decision is per request. Auto does not create lasting Frink permission rules.
- The provider reviewer can make mistakes, and it does not see every request: changes inside the folder the chat is working in are allowed without review, and only work outside that folder is reviewed. In a project chat that folder is the project. In a **general chat it is your whole home folder**, so Auto there can change files belonging to other projects without asking. Treat Auto as a convenience for work you trust, not as a guarantee against malicious instructions. The [system deny list](#whats-always-blocked-system-deny-list) still applies either way.

Claude Auto is available only on Claude Sonnet and Opus models that Frink reports as supported. Codex uses its native auto-review while retaining the `workspace-write` sandbox and `on-request` approval policy.

### Auto in Plan mode

Auto reviews tool requests in Plan mode too — both the **planning phase** (the reading and running the agent does to build its plan) and, when the plan is accepted, the implementing phase. So a Plan-mode chat or Flow with Auto on runs without stopping to ask you for eligible tools throughout. Auto is still **not** the same as approving the plan: the plan itself still stops for you unless the Flow step is set to **auto-approve** (that separate checkbox is what skips the plan review). Turning Auto on never auto-approves a plan.

Two things worth knowing. First, if the provider's reviewer cannot run for a plan step — for example on an unsupported model — Auto fails safe: an unattended Flow denies the tool rather than silently allowing it, while an attended chat may show denials instead of prompts in that rare case. Second, for a Flow's Plan step that is set to auto-approve, you will see the readout above the input switch from **Plan** to **Agent** with **Auto on** beside it once the plan is accepted, and the implementing half is reviewed the same way — on every kind of plan card.

## Agent tool limits

A custom agent's `.md` file can restrict which tools it may use:

```yaml
---
name: security-auditor
description: Reads code for security issues
tools: Read, Grep          # ONLY these (plus the agent-internal tools below)
disallowedTools: Edit      # or: everything EXCEPT these
---
```

On **Claude**, these limits are hard-enforced — twice. The runtime applies them when the agent is dispatched, and Frink's own gate independently checks every tool call the agent makes, denying anything off the list with a clear message. If both `tools` and `disallowedTools` are set, a disallowed entry wins.

Two things to know:

- **Matching is by tool name** (`Bash`, `Edit`, `mcp__github__create_pr`), not by what the call does with its arguments. Your scoped rules above (`Edit(src/**)` etc.) still apply on top.
- **Agent-internal tools always pass**: `TodoWrite`, `ExitPlanMode`, `Task`, `Agent` keep working even when not listed — they're how the agent tracks work, exits plan mode, and dispatches sub-agents. Blocking them just bricks the agent (same reason you can't `deny` them as rules).

On **Cursor** there is no per-tool veto, so the limit relaxes to the closest thing Cursor understands: an agent whose `tools` are all read-class follows as a `readonly` agent. Anything finer-grained than read-only doesn't carry to Cursor — the full limit applies again whenever the agent runs on a tool that can enforce it.

> Note: `disallowedTools` was previously accepted in agent files but not passed through to the runtime — it is now enforced. If an agent suddenly loses a tool, check its frontmatter.

## Inspecting + cleaning up

- Each rule is shown as a row in Settings → Permissions under its scope card. Click the X on the right to delete.
- If you added a rule that doesn't work (typo, wrong case, unsupported pattern), it'll sit in Settings doing nothing. Delete it and re-add with the right shape — the validator will help.
- Existing absolute-path rules from before the tool-wide grants feature still match (the matcher accepts both forms), but tool-wide is the cleaner shape.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Agent prompts on a file you've already allowed | Your rule was `Read(src/x.ts)`; agent asked for `Read(src/y.ts)`. Use a glob (`Read(src/**)`) or a tool-wide grant (`Read`). |
| "Allow {tool} for {project}" button disabled | File is outside the current project. Use Allow once, or open the file's owning project's chat. |
| Rule shows in Settings but never fires | Tool name wrong (typo or case). Delete + re-add — validator will catch it now. |
| Paste-file Read prompts every time | The paste was written under a different chat ID than the active chat. Restart the chat. |
| Want to grant something machine-wide | Add via Settings → User card. Note: rules at user scope apply across **every** project on the machine. |
