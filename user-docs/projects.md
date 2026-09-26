# Projects & general chat

Every chat in Frink either has a **project** (a folder the agent can read and write) or it doesn't (a **general chat**). You choose this with the picker right under the message box — the one that reads **Open project ▾** on a fresh chat.

The whole choice comes down to one question: **where do the files live?**

## Your options

Open the picker and you'll see **General chat** at the top, then your projects under **Recent**, then **Add project** at the bottom. **Add project** opens three ways to add one: **Start from scratch**, **Open a folder** and **Clone from GitHub**.

### 💬 General chat — no files

No project, no folder. The agent can answer questions, explain things, and help you think. This is the default: if you just type and send without touching the picker, you get a general chat.

Pick **General chat** explicitly if you want the picker to say so.

**What the agent can run here.** A general chat works from your home folder and is governed by the same permission rules as any project chat. For **commands**, Frink asks the first time and **Allow on this machine** saves the approval machine-wide, never asking for that command again. File **writes and edits** ask each time on Claude and Codex, with no save option yet in a general chat (a rule added in Settings can cover them). File **reads** prompt on Claude only; Codex never prompts a read. Frink also keeps a built-in deny list for credential paths (`~/.ssh`, `~/.aws`, `.env` files) on the surfaces it gates — it is a static check, not a sandbox, so some paths around it exist (search tools, Codex reads, commands whose targets Frink can't resolve). [Permissions](./permissions.md#whats-always-blocked-system-deny-list) states the exact coverage; OS-level sandboxing to close these structurally is the planned follow-up.

**Auto works here too.** [Auto permission mode](./permissions.md#auto-permission-mode) is available in a general chat on Claude and Codex, exactly as it is in a project chat. Worth knowing before you switch it on: Auto lets the agent change files inside the folder the chat works in without asking, and a general chat's folder is your **whole home folder** — including other projects on disk. The credential deny list above still applies. If you want that freedom scoped to one repo, open it as a project instead.

### ✨ Start from scratch — Frink picks the location

Frink creates a fresh, empty folder for you and the agent builds into it. You don't choose or even see a path — Frink auto-generates a location and tracks the project for you. Best for "I just want to build a thing" with no setup.

> Where does it actually go? Frink stores these under `~/.frink/builds/<name>` on your computer. You normally never need to know that — the project shows up in your sidebar and the **Open result** button (where available) opens what you built.

These projects are **plain folders with no Git** — nothing to install, nothing to configure. If you later want version history, you can add Git yourself; Frink doesn't require it.

### 📂 Open a folder — you pick the location

Opens a folder picker so **you** decide where the project lives. The folder can be **empty** (a new project at a location you control) or **already contain code** (your existing work — Frink just starts working in it). This is the path developers use to open an existing codebase.

### ⭳ Clone from GitHub

Paste a repo (`owner/repo` or a full GitHub URL) and Frink clones it to your computer and opens it as a project.

### Pick one of your projects

Anything you've created or opened before is listed under **Recent**, most recently used first, with how long ago you last worked in it. Pick one to start a fresh chat scoped to that project.

## Start from scratch vs. open a folder — what's the difference?

Both give you a project; they differ only in **where the folder lives and whether it already has code**:

| You pick | Frink does | Use when |
|----------|-----------|----------|
| **Start from scratch** | makes an empty folder and picks the location for you | you just want to build, don't care where |
| **Open a folder** | opens the folder you pick (empty *or* with existing code) | you want to choose the location, or open code you already have |

## Switching it for a chat

The picker only sets the context for the chat you're about to start. Open a new chat and it resets to **Open project** (general chat on send) — your previous projects are always one click away in the list.
