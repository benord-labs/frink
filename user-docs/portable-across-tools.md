# Your setup follows you across tools

Frink lets you move between coding tools — Claude, Codex, Cursor and more — without rebuilding your setup each time. Configure your servers, skills, and agents once, and they come with you when you change tools.

## The short version

- Set up your MCP servers, skills, commands, and custom agents once. Switch tools — they come with you.
- Frink keeps your setup in one place and hands each tool whatever it can use.
- Tool-native plugins come in a different format on each tool, so one stays on the tool you set it up in — but the skills and servers it bundles still follow you. (Frink's own **Plugins** are a separate thing, and they follow you like everything else.)
- Some tools enforce an agent's limits more strictly than others — limits apply in full on tools that can enforce them, and relax to the closest equivalent elsewhere.
- Your direct API tokens stay encrypted on your machine; OAuth connections (Slack, Gmail, GitHub, …) are authorized through a secure broker. Either way, Frink never *silently* touches the files committed to your repo — the one exception is a skill you explicitly **Copy across** into a project, and it warns you first.

## Switching tools

You choose which tool runs your work per project from **Settings → AI providers** — Claude or Codex. The moment you switch, Frink sets the new tool up with your config and tells you what came across and what changes. Your setup also reaches editors Frink doesn't run your chats through, Cursor included: it imports their config and writes yours back.

## What follows you

| Setup | Follows you? |
|---|---|
| MCP servers | Yes |
| Skills | Yes |
| Commands | Yes |
| Custom agents | Yes |
| Connected integrations | Yes (delivered as MCP) |
| Tool limits | Yes — enforced where the tool can, relaxed to read-only where it can't |
| Hooks | Not yet — on the roadmap |
| Tool-native plugins | Stays per-tool |

When you switch which tool runs your work, Frink brings your **MCP servers**, **skills**, **commands**, and **custom agents** along, so the new tool is set up exactly like the old one. You don't re-add anything.

For Codex, MCPs configured in Frink are supplied to each chat without copying credentials into Codex's own store. Existing Codex-only OAuth MCPs are not imported automatically yet; add them in **Settings → Plugins → MCP servers** once if you want Frink to own and deliver them across providers.

One small thing about **your own skills**: they follow you as real files, but the first time the new tool's agent *reads* one it asks permission — they're yours, not first-party, so they go through your normal approval (allow once and you're set). Skills Frink ships don't prompt. More in [Permissions](permissions.md).

In **Settings → Skills & agents** (the **Skills** and **Agents** tabs), each skill or agent shows as **one row** (duplicate listings across tools collapse into a single entry). A row that **every tool you use can read** needs nothing from you, so it carries no badge. One that a tool here can't read yet shows an amber **Only in _tool_** (or **Not shared** when none of your tools can read it), with **Copy across…** in its menu, so you can see at a glance what still needs to come across. Open a row to see which tools can read it and to open each copy. Frink's own built-in assets (like the `frink-flows` skill) show a read-only **Built-in** badge — Frink manages them and restores them when it restarts.

### Copy a skill or agent across

When a skill or custom agent lives in only one tool — say a Cursor-only one that Claude can't read — you can copy it the rest of the way:

- **At chat open**, if the tool you're starting can't read a **skill** in that project, Frink offers a one-tap **"make them follow you?"** prompt naming the skill(s). Not interested? Dismiss it — Frink won't nag every launch, and **"Don't ask again"** stops it for that skill for good (a brand-new skill still prompts).
- **Any time**, from the skill's or agent's row in **Settings → Skills & agents**, use **Copy across…**.

You choose two things: **where** (Global, so it follows you on this machine everywhere, or a specific project) and **how far** (**Portable** — readable by all your tools — or just the one tool). It's always a **copy** — the original stays where it is, and a hand-edited copy is never overwritten. Copying into a project may add files to that project's repo (if its `.claude`/`.cursor` isn't gitignored); Frink tells you when that happens.

This explicit copy covers **skills and agents today** — commands use the same flow soon. (Agents are copied verbatim, except a few Claude-only fields like the model and tool list, which don't translate to Cursor and fall back to its defaults.) The one skills-only bit is the *at-chat-open* prompt above; the row-level **Copy across…** works for both. Everything else still *auto-follows* you when you switch tools, into machine-local config — that part already covers MCP servers, skills, commands, and agents, and never touches your repo.

**Plugins are the one exception — and only their packaging.** Every tool has its own plugin format, so a plugin you set up in one tool can't be dropped into another. The *package* stays where you set it up; the useful parts inside it — its skills, servers, and commands — still follow you everywhere, as usual.

Frink's own plugins (the ones you connect from **Settings → Plugins**, like Slack or Shortcut) are plugins like any other — Frink just ships them itself and takes care of the account sign-in and the triggers for you. That's why your connected account and its triggers come with you whichever tool you switch to. How much of the rest each tool can use varies, and every plugin's page says so under **Works in**.

## How strict your rules stay

Say you built an agent called **Security Auditor** and told it *"only allowed to read files, never edit."*

- On tools that can enforce that precisely, the limit carries over exactly.
- On tools that only offer a coarser "read-only or not" switch, the fine-grained limit relaxes to the closest thing that tool understands.

Frink tells you what changed when you switch tools. The agent itself (its name and instructions) always comes with you. Tool-specific settings — which model it runs on, and how tightly its rules are policed — translate to the closest thing the new tool offers: model names differ between tools, so on a new tool the agent starts on that tool's default model until you pick one.

**Hooks** (like *"block dangerous commands"*) currently stay on the tool you set them up in — bringing them along is on the roadmap.

And if a tool can't take a piece of your setup at all, Frink doesn't force it — that piece stays where you set it up, and works again the moment you switch back.

## What stays on your machine

- **Credentials** — Direct API-token integrations (and your tool logins) are encrypted on your device and never leave it — not to the cloud, not to another machine. OAuth integrations (Slack, Gmail, GitHub, …) are authorized through a secure broker that holds their tokens server-side; those tokens are never written to your repo or synced to your other machines.
- **Your repo** — Frink writes setup to your machine's own config, and never *silently* edits the `.claude/`, `.cursor/`, or similar files committed to your project, so your teammates aren't affected by your personal setup. The one time it writes there is when *you* explicitly **Copy across** a skill into a project — a deliberate choice it surfaces (and warns about if the files would land in your repo).

## FAQ

**Q: I switched tools and my MCP servers were just there — did I miss a step?**
No. Frink moved them for you when you switched. Nothing to set up again.

**Q: My agent could edit files on one tool but not another. Why?**
That tool enforces the agent's limits differently — the agent is the same, only the strictness changed. Frink tells you what shifts the moment you switch; see "How strict your rules stay" above.

**Q: Will switching tools change my committed `.cursor` or `.claude` files?**
No. Switching tools writes only machine-local config — your repo is untouched. The single exception is when *you* choose **Copy across → a project**: that deliberately copies the skill into that project (Frink warns you when those files would become part of its repo).

**Q: I uninstalled Frink — is my setup gone?**
Your original tool configs are intact and your tokens stay in your operating system's keychain. Frink's own copy goes away, but you keep working.

**Q: Why don't plugins follow me when everything else does?**
Because every tool packages plugins its own way, there's no shared format a plugin could travel in. Its useful contents (skills, servers, commands) still follow you everywhere; only the package stays put. Frink's own plugins are no different as plugins — Frink just ships them and handles the account and triggers for you, so those two parts stay yours in every tool. The plugin's **Works in** grid says what else each tool gets.
