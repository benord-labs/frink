# AI accounts

Frink runs your chats through Claude (Anthropic, via Claude Code), OpenAI (via Codex) or, on macOS, OpenCode or GitHub Copilot. If you're already signed into one in your terminal, that's all Frink needs — it uses the same sign-in, as you. This guide covers how to connect, what Frink stores, and why things behave the way they do.

## Connecting

### Use your Claude Code or Codex sign-in (recommended)

1. Sign in once in your terminal: `claude auth login` or `codex login`.
2. In Frink, open a new chat and click **Connect Claude** or **Connect OpenAI**, or go to Settings → AI providers → **Add an account** → **Sign in with Claude** / **Sign in with OpenAI**. Frink names the account after the sign-in's email; rename it any time from the account's ⋯ menu. A Codex sign-in kept in the macOS keychain is named "OpenAI" instead: Frink only checks that it exists and never reads it, so it can't see the email.

That's it. **Frink never reads or stores your token.** It only checks that the sign-in exists; the `claude` or `codex` program Frink launches reads its own credential and refreshes it itself, exactly as it does in your terminal.

Every AI account belongs to this computer — Claude and OpenAI sign-ins and API-key accounts alike.

### OpenCode (macOS)

OpenCode is a free, open-source coding agent that can use many AI providers, including free models. Frink runs the OpenCode you install yourself.

1. Install OpenCode 1.19 in your terminal: `npm install -g opencode-ai@1.19`. Check it with `opencode --version`.
2. Optional: run `opencode auth login` to add your own AI provider. Without it you get OpenCode's free models.
3. In Frink, go to Settings → AI providers → **Add an account** → **Connect OpenCode**.

**Frink stores no credential for OpenCode.** OpenCode keeps its own sign-ins, and Frink only checks that OpenCode is installed. The model picker shows "OpenCode default" until your first message, then the models OpenCode offers.

What to know:

- **Frink ignores your OpenCode config files while it runs OpenCode, for safety.** Your settings could let OpenCode act without asking, so Frink starts it with its own. Your sign-ins and your instructions files (`AGENTS.md`, `CLAUDE.md`) still apply.
- **OpenCode asks Frink before every command, file change, web fetch or web search**, and you answer on the same cards as any other chat. Frink also holds each command until it has been allowed. Reading and searching files in the chat's folder doesn't ask (in a general chat that folder is your home folder). Opening a `.env` file asks first, but a search of the folder can still show lines from one. If OpenCode ever finishes an action without asking, Frink stops the chat. More in [Permissions](./permissions.md#opencode).
- **Not in OpenCode chats yet:** Auto, Flows, MCP servers, Frink's own chat tools (such as building a Flow from a chat), adding to a running turn (a message you send waits for the turn to end; **Send now** stops the turn first), Debug mode and OpenCode's own slash commands. Plan mode uses OpenCode's own plan mode.
- **OpenCode chats aren't counted in the Usage tab.** They also show up in OpenCode's own list of past sessions.
- **macOS only for now.** Linux and Windows aren't supported yet.
- **OpenCode 2 previews aren't supported yet.** Frink shows, for example, "Frink has checked OpenCode 1.19. You have 2.0.29, which Frink hasn't checked yet." To go back to 1.19:
  1. Remove OpenCode 2 the way you installed it. If you used OpenCode's install script, delete `~/.opencode/bin/opencode`, or Frink keeps finding it.
  2. Move OpenCode's data folder aside, because 1.19 can't open the one OpenCode 2 wrote: `mv ~/.local/share/opencode ~/.local/share/opencode-2-backup`. This hides your OpenCode 2 sessions and sign-ins (move the folder back if you return to OpenCode 2).
  3. Install 1.19 with `npm install -g opencode-ai@1.19`, check that `opencode --version` shows 1.19, and run `opencode auth login` again if you use your own AI provider.

### GitHub Copilot (macOS)

GitHub Copilot is GitHub's coding agent. Frink runs the Copilot you install yourself, signed in with your own GitHub account, including the free plan.

1. Install Copilot in your terminal: `npm install -g @github/copilot`. Check it with `copilot --version`.
2. Sign in: run `copilot login` and finish in your browser.
3. In Frink, go to Settings → AI providers → **Add an account** → **Connect GitHub Copilot**.

**Frink stores no credential for GitHub Copilot.** Copilot keeps its own sign-in. Frink only checks that Copilot is installed, and that it's signed in each time a chat sends a message. The model picker shows "GitHub Copilot default" until your first message, then the models your plan offers. A free plan offers one model, Auto. Models that let you choose how hard they think show the effort slider.

What to know:

- **Frink has checked GitHub Copilot 1.0.96 and later 1.0 releases.** Copilot updates itself, so a newer release can stop working in Frink until Frink checks it. Frink tells you when that happens.
- **Inside Frink, your own Copilot hooks, MCP servers and saved approvals don't apply, for safety.** They could let Copilot act without asking, so Frink starts Copilot with its own settings. Your sign-in still applies, and Copilot in your terminal is unchanged.
- **GitHub Copilot asks Frink before every command, file change, web fetch or web search**, and before it reads anything outside the chat's folder. You answer on the same cards as any other chat. Reading and searching files in the chat's folder doesn't ask (in a general chat that folder is your home folder), and that includes `.env` files. If Copilot ever finishes an action without asking, Frink stops the chat. More in [Permissions](./permissions.md#github-copilot).
- **Plan mode uses Copilot's own plan mode.** Copilot saves its plan to a file in Frink's own Copilot folder, and Frink lets that one file through without a question. You may still see a card when Copilot first writes or reads it. The plan shows as Copilot's reply, not as a plan card.
- **Not in Copilot chats yet:** Auto, Flows, MCP servers, Frink's own chat tools (such as building a Flow from a chat), adding to a running turn (a message you send waits for the turn to end; **Send now** stops the turn first) and Debug mode.
- **Organisation-managed and GitHub Enterprise Server accounts aren't supported yet.** Frink won't start Copilot when an organisation or your device manages its settings.
- **Copilot chats use your Copilot plan, the same as in the terminal.** They aren't counted in the Usage tab.
- **macOS only for now.** Linux and Windows aren't supported yet.

### API key

If you'd rather keep credentials inside Frink, paste an Anthropic API key (`sk-ant-api…`) under Settings → AI providers → **Add an account** → **Add a Claude API key**. The name is optional (it defaults to "Claude API key", then "Claude API key 2" and so on). The key is encrypted with `safeStorage` (macOS Keychain, libsecret on Linux) and stays on this machine. Paste it again on another machine to use it there.

You can have **as many API-key accounts as you want** — useful for separating Work vs Personal vs different orgs. Add a new one any time and pick which one a project uses in that project's settings (the account menu on a new chat only changes the chat you're starting). The account marked **Used for new chats** is the default; change it from another account's ⋯ menu.

## How your sign-in behaves

These are the things people notice and wonder about:

- **Frink always runs as whoever is signed in right now.** If you switch accounts in your terminal (or with an account switcher), your next chat simply runs as the new account. Nothing to reconnect. The account's name in Frink stays whatever you called it (a Claude account also shows the email it last ran as, which updates with you).
- **Signed out? Chats pause until you sign back in.** A new chat shows **Sign back in to keep chatting** (an open chat shows *your account* **was signed out**) and re-checks every few seconds. Run `claude auth login` or `codex login` and it clears on its own — you don't have to click anything (a **Sign in again** button is there too if you prefer, and the other provider is offered as a switch).
- **Removing an account never moves its chats.** A chat keeps the account and provider it started with. If you remove that account, the chat stops with **This chat's login was removed** and offers **Retry with** another account of the same provider, or to add one.
- **Rotation can't interrupt a running agent.** The agent holds the credential itself and refreshes it mid-run under the same lock your terminal uses. Earlier versions handed the agent a copy of the token taken at start time, so anything that rotated your credential — another terminal, another app — revoked that copy and every in-flight agent failed at once with a 401. That whole class of failure is gone.
- **One sign-in per provider per machine.** This mirrors how `claude` and `codex` themselves work: one sign-in per user, not one per project. For Claude it has to be the main sign-in — `claude` also creates project-scoped sub-credentials when used inside specific folders, and Frink can't use those. If Frink reports no sign-in found, run a top-level `claude auth login`. To use a second Anthropic identity in the same Frink, add an API-key account.
- **Each machine connects on its own.** Sign-ins and API keys live on that machine and don't travel. On a new Mac you'll see the connect prompt again — connect once and you're done. Names are per machine too ("Personal Claude" on your laptop, "Work Claude" on your desktop).
- **macOS asks about the keychain once, when you connect.** "Frink wants to use your confidential information stored in 'Claude Code-credentials' in your keychain." Click **Always Allow**. It happens at connect time on purpose — that's the one moment the dialog is in front of you. Afterwards Frink only checks that the entry still exists, which needs no access to its contents.

## Which `claude` binary does Frink use?

**Frink ships its own bundled `claude` binary.** It does not call the `claude` you have installed in `/usr/local/bin`, `~/.npm/bin`, Homebrew, nvm, or anywhere else.

Why this matters:

- **Versions can drift.** If Anthropic ships a new `claude` v2.X with a feature your terminal `claude` has but Frink's bundled one doesn't, Frink won't have that feature until the next Frink update.
- **Your sign-in still works across both binaries.** The macOS keychain entry (`Claude Code-credentials`) is shared at the OS level. Whether you ran `claude auth login` from your terminal `claude` or Frink's bundled one, both can read it.
- **You can't currently point Frink at a custom `claude`.** Custom binary path / launch arguments are on the roadmap (see [t3code](https://github.com/pingdotgg/t3code) for prior art); not supported today.

If you hit a feature gap because of version skew, opening an issue with the `claude` version difference is the fastest path to getting it fixed.

## What Frink stores per account

All of it lives on this machine and nothing leaves it — each machine connects on its own.

| Account | What's stored |
|---|---|
| **Claude Code sign-in** | A pointer to the keychain entry. No token. |
| **OpenAI sign-in** | A pointer to your local Codex sign-in. No token. |
| **OpenCode** | A note that OpenCode is connected. No token. |
| **GitHub Copilot** | A note that GitHub Copilot is connected. No token. |
| **API key** (Anthropic) | The encrypted token via Electron `safeStorage`. |

Reconnecting an account never creates a duplicate: Frink updates the existing row in place, so your project assignments and default-account setting are kept.

### Choosing models

Settings → AI providers → **Models** lists the models of each connected provider, with a switch to show or hide each one in the model picker. The newest model of each kind is listed first; older versions sit behind **Show N older models**. Each provider keeps at least one model on.

## Usage

**Settings → Usage** (or the gauge icon at the bottom of the sidebar, next to Discord) opens with how you've used Frink on this computer:

- **Your totals.** Tokens since your first Frink chat here, your busiest day, your current and best streak of days in a row, and how many conversations you've had. Tokens count what the AI read and wrote. Re-reads of earlier messages aren't counted, so this number won't match your plan limits.
- **Activity.** A year of days, darker where you used Frink more. Hover a day to see its tokens. If you use both Claude and OpenAI, you can show just one of them.
- **Highlights and Most used.** Your flow runs, finished tasks, top flow, favourite model and busiest time of day, plus the skills and integrations your chats use most.
- **Read from this computer only.** Frink works these out from its own chat history on disk; nothing is sent anywhere. The first time can take a moment; after that it only reads what's new.

### Plan limits

Below that, the same tab shows how much of your Claude and OpenAI (ChatGPT) plans is left in each rolling limit: the 5-hour session window, the weekly window, and for ChatGPT Free or Go the monthly allowance. Each window has a reset countdown and a link to manage usage on claude.ai or chatgpt.com. It's the same readout as Claude Code's `/usage` and Codex's `/status`, read through Frink's bundled `claude` and `codex` programs. Frink never reads your token to get it.

- **Subscription logins only.** Claude needs a Pro, Max, Team or Enterprise login; OpenAI needs a ChatGPT plan login. API-key accounts have no plan limits, so that group shows a short message and a link to AI providers instead of bars.
- **No chat needed.** Frink starts a brief background session for each provider that only reads usage. It sends no message, so it costs nothing against your plan. Each is read at most every 5 minutes while the tab is open, and the "updated Xm ago" label shows how fresh it is.
- **Each window shows what's left.** The bar's fill is the share of the window you have left. A thin line marks where you'd be if you spent evenly, and an icon shows whether you're ahead of, on, or under that pace. Per-model weekly limits (for example Fable) get their own row.
- **The logins you're signed in to.** Each group names the plan and email it belongs to: the login Claude Code or Codex is using right now, even when the other provider is your overall default. If you switch Claude logins, including with an account-switcher app, the tab reads the new login straight away and never shows the old one's bars.

## When things go wrong

- **"Sign back in to keep chatting"** (or **"… was signed out"** in an open chat) — the account exists but its sign-in is missing. Just sign back in from your terminal with `claude auth login` or `codex login` — Frink re-checks every few seconds and recovers on its own; the **Sign in again** button does the same thing. For an API-key account, paste a fresh key under Settings → AI providers.
- **macOS denied keychain access** — open System Settings → Privacy & Security → Keychain and re-allow Frink, OR run `claude auth login` to refresh the entry. You'll only ever be asked about the one main entry, and only while connecting.
- **"An account named X already exists"** when adding a new account — pick a different name, or disconnect the existing one first. Same-name accounts would collide unpredictably.
- **Linux without a keyring** — Frink won't store a key or token it can't encrypt, so adding the account shows an error instead. Install GNOME Keyring or KWallet, relaunch Frink, then add the account again.
- **"Frink has checked OpenCode 1.19. You have …"** — you have a different OpenCode, often a 2 preview. Follow the steps to go back to 1.19 under [OpenCode (macOS)](#opencode-macos), then try again.
- **"Settings from an organisation, sign-in provider or administrator can change how OpenCode asks for permission"** — your OpenCode gets settings from an organisation account, a company sign-in or your administrator, so Frink can't be sure it will still ask before it acts. Sign out of the organisation account with `opencode console logout`, or use Claude or OpenAI on this computer.
- **"GitHub Copilot isn't signed in"** — run `copilot login` in Terminal, finish in your browser, then send your message again.
- **"Frink can't find GitHub Copilot on this computer"** — install it with `npm install -g @github/copilot`, check that `copilot --version` works in Terminal, then try again.
- **"Frink has checked GitHub Copilot 1.0.96 and later 1.0 releases. You have …"**, **"Frink has checked GitHub Copilot CLI 1.0.96 and later 1.0 releases. You have …"** or **"This GitHub Copilot release talks to apps in a way Frink doesn't support yet"** — your Copilot is a version Frink hasn't checked. If it's older, run `copilot update`. If it's newer (Copilot updates itself), use Claude, OpenAI or OpenCode until Frink is updated for it.
- **"Frink couldn't tell which version of GitHub Copilot you have"** — run `copilot --version` in Terminal. If that fails too, install Copilot again.
- **"Your organisation or device manages GitHub Copilot's settings, so Frink can't run it safely"** — those settings could let Copilot act without asking, so Frink won't start it. If you also have a personal GitHub account, switch Copilot to it (start `copilot` in Terminal and type `/user switch`), or use Claude or OpenAI on this computer.
- **"Frink can't run GitHub Copilot for GitHub Enterprise Server accounts yet"** — sign in to Copilot with a github.com account instead, or use Claude or OpenAI.
- **"GitHub Copilot didn't confirm Frink's safety settings"**, **"… stopped confirming Frink's safety settings"** or **"… started without asking before changes"** — Copilot didn't start the way Frink needs, so Frink stopped it before it could act on its own. Send your message again. If it keeps happening, update Copilot with `copilot update`, or use another provider.
- **"GitHub Copilot couldn't turn Plan mode on or off as asked"** — your message wasn't sent. Send it again.
- **"Frink can't check this tool yet, so it didn't run"** — Copilot tried a tool or option Frink doesn't know how to ask you about. Nothing ran, and Copilot usually tries another way.
