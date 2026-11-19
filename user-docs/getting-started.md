# Getting started

This page takes you from a fresh install to your first chat. It takes a couple of minutes.

## What Frink is

Frink runs AI coding agents (Claude Code, Codex CLI, OpenCode, GitHub Copilot or Cursor) on your machine, against your real folders. You can chat with one, run a few at once, or wire them into automated Flows. It's the same agent you'd run in a terminal, with a UI around it.

## First launch

The first time you open Frink you get a short "Welcome to Frink" screen. Click **Get started**, or press **Enter**, to dismiss it. You only see it once.

After that you land in the app with no AI account connected. Connecting one is the first thing to do.

## 1. Connect an AI account

Frink has no model of its own. It runs your Claude, Codex, OpenCode, GitHub Copilot or Cursor, so you connect an account before you can chat.

Claude, Codex and Cursor need nothing installed: you sign in from Frink. For GitHub Copilot you'll need the `copilot` CLI installed and logged in first. OpenCode only needs to be installed.

- **Claude (recommended).** On the empty state, click **Connect** next to Claude. If you're not signed in to Claude on this computer yet, click **Sign in with Claude**, finish in your browser, and Frink connects by itself. Frink hands that login to the agents it runs — there's no token to store, and the `claude` CLI keeps it fresh itself, so a token rotation can't knock out a running agent. On macOS you'll be asked for keychain access once, while connecting. Click **Always Allow**. Or click **Add it in Settings**, under the list, to paste an Anthropic key (`sk-ant-api…`) instead.
- **Codex.** On the empty state, click **Connect** next to OpenAI (or add a Codex account in Settings). If you're not signed in to ChatGPT on this computer yet, click **Sign in with ChatGPT**, finish in your browser, and Frink connects by itself. Frink reads that login at chat-time and stores no token.
- **OpenCode (macOS and Linux).** Install it with `npm install -g opencode-ai@1.19`, then go to Settings → AI providers → **Add an account** → **Connect OpenCode**. It works with OpenCode's free models; run `opencode auth login` first to add your own AI provider. Frink stores no credential. Some chat features aren't in OpenCode chats yet: see [AI accounts](./ai-accounts.md#opencode-macos-and-linux).
- **GitHub Copilot (macOS and Linux).** Install it with `npm install -g @github/copilot`, run `copilot login`, then go to Settings → AI providers → **Add an account** → **Connect GitHub Copilot**. The free plan works. Frink stores no credential. Some chat features aren't in Copilot chats yet: see [AI accounts](./ai-accounts.md#github-copilot-macos-and-linux).
- **Cursor (macOS and Linux).** Go to Settings → AI providers → **Add an account** → **Connect Cursor**, click **Sign in to Cursor** if asked and finish in your browser. Cursor needs a paid Cursor plan. Frink stores no Cursor key. Some chat features aren't in Cursor chats yet: see [AI accounts](./ai-accounts.md#cursor-macos-and-linux).
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
