# What Frink sends

Your chats, code, Flows and settings stay on your computer. Official builds of Frink report two things to its maintainers: anonymous usage counts and crash reports. This page lists all of it.

A build you make yourself from source contains no keys, so it sends none of this. `bun run dev` never sends anything either.

## Usage counts

These go to PostHog and answer questions like "how many installs opened Frink this week".

| Event | When | What it carries |
| --- | --- | --- |
| `desktop_opened` | Frink starts | Whether this is the install's first launch |
| `first_launch` | The first launch only | Nothing extra |
| `project_opened` | You add or open a project | The project's local id, and whether it has a git remote (yes or no) |
| `workspace_created` | A chat is created in a project | The chat's and project's local ids, and whether it uses a worktree |
| `workspace_archived`, `workspace_deleted` | You archive or delete a chat | The chat's local id |
| `message_sent` | You send a message | The chat's local id, the message's length in characters, and the chat mode |
| `pr_created` | A chat's reply links a new GitHub pull request | The chat's local id and the pull request number |

Every event also carries the Frink version, your operating system and chip architecture, and the Electron and Node versions inside the app.

**What identifies you:** a random install ID. Frink generates it the first time it sends an event and keeps it in its app data folder. It is not built from your computer, your name, your email or your AI account, so it tells one install apart from another and nothing more. The local ids above are ids Frink made up for its own database, built from the time the item was created and a few random characters.

**What is never sent:** prompts, messages, replies, code, file names or paths, repository names or URLs, branch names, and anything about your AI provider account.

Your IP address reaches PostHog as it does any server you connect to. Frink sends events with location lookup turned off.

### Turning usage counts off

Open **Settings → Preferences → Privacy** and switch off **Share Usage Analytics**. From that moment Frink records no usage events, and it sends none at launch while the switch is off. If the switch was off before Frink ever sent an event, no install ID is created.

## Crash reports

When Frink itself hits an error or crashes, an official build sends a report to Sentry: the error and its stack trace, the Frink version, details of your system such as its operating system and memory, and a short trail of what the app was doing (screen changes, clicks and internal calls, with values reduced to their type).

Before a report leaves your computer, Frink:

- replaces your home folder name in error messages and file paths,
- blanks anything in them shaped like a token or API key,
- drops the whole report if the error came from code that handles prompts, file contents, terminal output or credentials.

A crash of the app's native code also uploads a crash dump of the process that crashed.

The **Share Usage Analytics** switch does not turn crash reports off.

## Everything else

Connections you set up yourself, such as your AI provider, plugins, webhooks and the phone app, are covered in their own guides. Official builds also ask Frink's download server whether a newer version exists.
