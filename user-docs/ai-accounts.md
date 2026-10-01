# AI accounts

Frink runs your chats through Claude (Anthropic, via Claude Code) or OpenAI (via Codex). If you're already signed into either one in your terminal, that's all Frink needs — it uses the same sign-in, as you. This guide covers how to connect, what Frink stores, and why things behave the way they do.

## Connecting

### Use your Claude Code or Codex sign-in (recommended)

1. Sign in once in your terminal: `claude auth login` or `codex login`.
2. In Frink, open a new chat and click **Connect Claude** or **Connect OpenAI**, or go to Settings → AI providers → **Add an account** → **Sign in with Claude** / **Sign in with OpenAI**. Frink names the account after the sign-in's email; rename it any time from the account's ⋯ menu.

That's it. **Frink never reads or stores your token.** It only checks that the sign-in exists; the `claude` or `codex` program Frink launches reads its own credential and refreshes it itself, exactly as it does in your terminal.

Every AI account belongs to this computer — Claude and OpenAI sign-ins and API-key accounts alike.

### API key

If you'd rather keep credentials inside Frink, paste an Anthropic API key (`sk-ant-api…`) under Settings → AI providers → **Add an account** → **Add a Claude API key**. The name is optional (it defaults to "Claude API key", then "Claude API key 2" and so on). The key is encrypted with `safeStorage` (macOS Keychain, libsecret on Linux) and stays on this machine. Paste it again on another machine to use it there.

You can have **as many API-key accounts as you want** — useful for separating Work vs Personal vs different orgs. Add a new one any time and pick which one a project uses in that project's settings (the account menu on a new chat only changes the chat you're starting). The account marked **Used for new chats** is the default; change it from another account's ⋯ menu.

## How your sign-in behaves

These are the things people notice and wonder about:

- **Frink always runs as whoever is signed in right now.** If you switch accounts in your terminal (or with an account switcher), your next chat simply runs as the new account. Nothing to reconnect. The account's name in Frink stays whatever you called it (a Claude account also shows the email it last ran as, which updates with you).
- **Signed out? Chats pause until you sign back in.** The chat shows **Reconnect to keep chatting** and re-checks every few seconds. Run `claude auth login` or `codex login` and it clears on its own — you don't have to click anything (a **Reconnect** button is there too if you prefer).
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

- **"Reconnect to keep chatting"** — the account exists but its sign-in is missing. Just sign back in from your terminal with `claude auth login` or `codex login` — Frink re-checks every few seconds and recovers on its own; the Reconnect button does the same thing. For an API-key account, paste a fresh key under Settings → AI providers.
- **macOS denied keychain access** — open System Settings → Privacy & Security → Keychain and re-allow Frink, OR run `claude auth login` to refresh the entry. You'll only ever be asked about the one main entry, and only while connecting.
- **"An account named X already exists"** when adding a new account — pick a different name, or disconnect the existing one first. Same-name accounts would collide unpredictably.
- **Linux without GNOME Keyring** — Frink will warn before storing tokens unencrypted on disk. The recommended fix is to install `libsecret-tools` so encryption is available.
