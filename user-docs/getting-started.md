# Getting started

This page takes you from a fresh install to your first chat. It takes a couple of minutes.

## What Frink is

Frink runs AI coding agents (Claude Code or Codex CLI) on your machine, against your real folders. You can chat with one, run a few at once, or wire them into automated Flows. It's the same agent you'd run in a terminal, with a UI around it.

## First launch

The first time you open Frink you get a short "Welcome to Frink." screen. Click **Get started**, or press **Enter**, to dismiss it. You only see it once.

After that you land in the app with no AI account connected. Connecting one is the first thing to do.

## 1. Connect an AI account

Frink has no model of its own. It runs your Claude or Codex, so you connect an account before you can chat.

You'll need the matching CLI installed and logged in first: the `claude` CLI for Claude, the `codex` CLI for Codex.

- **Claude (recommended).** On the empty state, click **Connect Claude (subscription)**. If you've already run `claude auth login` in your terminal, Frink hands that login to the agents it runs — there's no token to store, and the `claude` CLI keeps it fresh itself, so a token rotation can't knock out a running agent. On macOS you'll be asked for keychain access once, while connecting. Click **Always Allow**. Or click **Add API key** to paste an Anthropic key (`sk-ant-api…`) instead.
- **Codex.** Run `codex login` in your terminal, then add a Codex account in Settings. Frink reads that login the same way, at chat-time, and stores no token.
- **Windows.** Claude's terminal login is macOS and Linux only. On Windows, connect Claude with an Anthropic API key.

For more on accounts (multiple logins, what gets stored, using more than one machine), see [AI accounts](./ai-accounts.md).

## 2. Start your first chat

Once an account is connected, open a new chat, type, and send.

The picker under the message box decides where files live:

- **General chat.** No folder. The agent works from your home folder under the same permission rules as any project chat — it asks before running commands or touching files, unless you turn [Auto](./permissions.md#auto-permission-mode) on. This is the default.
- **A project.** Point Frink at a folder, or let it pick one, and the agent can read and write files there.

[Projects & general chat](./projects.md) covers the difference.

## Where to go next

Once you're chatting:

- [Projects & general chat](./projects.md): folders versus general chat, and how the picker works.
- [Files](./files.md): how the agent sees and edits your files.
- [Changes](./changes.md): review what the agent changed, and ask it to commit or open a pull request.
- [Task lifecycle](./task-lifecycle.md): what happens while an agent runs.
- [Permissions](./permissions.md): what the agent can do, and how to change it.
- [Flows](./flows.md): wire chats, triggers, and several agents into automations.
- [MCP servers](./mcp-servers.md): give your agents extra tools.
- [Worktree setup](./worktree-setup.md): run setup commands automatically when a chat's worktree is created.

## Seeing the welcome screen again

Frink shows the welcome screen once and then remembers. There's no setting to bring it back. It's a one-time hello.
