# Worktree setup

When a chat runs in a **worktree** (an isolated git checkout so an agent can work without touching your main branch), Frink copies in the local files git doesn't track, like your `.env`, and can run setup commands right after creating it — installing dependencies, whatever else your project needs to be immediately usable.

Get a chat into worktree mode with the **Local / Worktree** switcher next to the project picker, under the message box, when starting a new chat with a project selected.

Setup commands are configured per project and none run by default. Your `.env` files are copied into every new worktree even with no configuration — see [Files copied automatically](#files-copied-automatically).

## Two different `.frink` paths

These sound alike but are unrelated:

| Path | What it is |
|---|---|
| `<project>/.frink/worktrees.json` | A **file in your project repo** listing the setup commands to run. Commit it so anyone who worktrees your project gets the same setup. |
| `~/.frink/worktrees/` | The **folder on your machine** where worktree checkouts themselves live (the base directory, overridable per project — see below). |

This page is about the first one.

## Configuring setup commands

Open **Settings → Projects → your project**. Under **Worktrees → Setup commands**, type each command into the empty last row; they run in order in the new worktree, right after it's created. Each row runs as its own command, so a `cd` in one row doesn't carry to the next — press **Shift+Enter** to put several lines in one row when they need to run together. Changes save automatically when you leave a field or press Enter.

Use `$ROOT_WORKTREE_PATH` to reference the main checkout. You don't need a command to copy `.env` files: Frink does that for you.

```json
{
  "setup-worktree": ["bun install"]
}
```

Settings saves this to `.frink/worktrees.json` at your project root, changing only the keys you edited, so anything else in the file is kept. To have an agent inspect the project and write the file for you, run `/worktree-setup` in a chat.

`setup-worktree` must be a list of strings. If Frink can't read the file — a typo, a trailing comma, or a single string instead of a list — Settings says so and won't save over it until you fix it.

If no config file is found, worktree creation is silent — no commands run, nothing is reported as missing. If the file exists but can't be read, setup is skipped and Frink logs that "couldn't read" message; Settings shows it too.

**Windows:** setup commands run through Git Bash (the one bundled with Git for Windows), so POSIX syntax like `cp` and `$VAR` works as shown above. If Git Bash isn't found next to your git install, commands silently fall back to `cmd.exe`, where that syntax doesn't run as written.

## Files copied automatically

A new worktree only has the files git tracks. Before any setup command runs, Frink copies in the files from your main checkout that git ignores and the worktree needs:

- **By default:** every `.env` file git ignores, at any depth — `.env`, `.env.local`, `apps/web/.env.local` and so on. Templates (`.env.example`, `.env.sample`, `.env.template`) are left out, since they're usually tracked anyway.
- **With a `.worktreeinclude` file** at the root of your repo: exactly the files it lists, instead of the default. It uses `.gitignore` syntax, including `!` to leave a file out. Claude Code and other tools read the same file. If you add one, list your `.env` files in it too, because it replaces the default.

Only files git ignores are copied: tracked files are already in the worktree. A file the worktree already has is never overwritten, and files are copied rather than linked, so an agent's edits never reach your main checkout. Frink skips any file over 5 MB, and stops at 1,000 files or 50 MB in total. A file that is a link to somewhere outside your repository is never copied, so a link can't pull in something like your SSH key.

A pattern without a slash, like `settings.json`, doesn't reach inside a folder git ignores as a whole (such as `.vscode/`); write the path instead, like `.vscode/settings.json`. This keeps folders like `node_modules` from being scanned.

**Settings → Projects → your project → Worktrees** lists exactly the files the next worktree will get. Turn the switch next to that list off if you don't want them copied, for example when your `.env` holds production keys that agents shouldn't use. The switch is saved on your computer only, in your repository's local git settings, so it never reaches anyone you share the project with. It covers every Frink project in that repository.

Frink also skips any file the new worktree itself doesn't ignore. That happens when your main checkout ignores it through a change to `.gitignore` you haven't committed: without the skip, the file would show up as a new file in the worktree, and an agent could commit it.

### Worktrees an agent makes itself

The `.env` copy above is something Frink does for the worktrees it makes. An agent can also make a worktree on its own partway through a chat, and no agent copies your `.env` files into it by default:

| Agent | Makes its own worktrees during a Frink chat | What it copies in |
|---|---|---|
| Claude | Yes: when you ask it to work in a worktree, or when it starts helper agents | Only the files listed in a `.worktreeinclude` |
| Codex, Cursor, GitHub Copilot, OpenCode | No | Doesn't apply |

So a worktree Claude makes starts with no `.env` unless your repo has a `.worktreeinclude`. To have your `.env` files there too, add one at the root of your repo that lists them:

```
.env*
!.env*/
```

The second line leaves out folders named like `.env`, such as a Python virtual environment, which Frink's default skips too. Frink then copies the same list, since a `.worktreeinclude` replaces its default (see above).

The switch in Settings only covers worktrees Frink makes. If your `.env` holds keys agents shouldn't use, leave it out of `.worktreeinclude` too, so worktrees an agent makes don't get it either. A `WorktreeCreate` hook replaces how Claude makes worktrees, and Claude then ignores `.worktreeinclude`, so a hook like that has to copy these files itself.

## Claude settings and hooks come from the main checkout

A Claude chat in a worktree uses your main checkout's Claude setup, as Claude Code's own worktree sessions do. Project settings and hooks (including the uncommitted `.claude/settings.local.json`), skills, agents and commands are read from the main checkout, so there is no need to copy them with setup commands. A change to those files on the worktree's branch takes effect once it is in the main checkout. A hook that needs the folder Claude is working in should read `cwd` from its input: `$CLAUDE_PROJECT_DIR` points at the main checkout.

## Overriding where worktrees are created

By default worktrees are created under `~/.frink/worktrees/` (change that default in **Settings → Preferences**). The project's **Worktrees → Location** field puts that project's new worktrees somewhere else — leave it empty to use the default.

## Cursor's `.cursor/worktrees.json`

If you also use Cursor, note that Frink and Cursor do **not** share worktree setup config — Frink only reads `.frink/worktrees.json`, and won't pick up an existing `.cursor/worktrees.json` even though the two use the same `setup-worktree` key and `$ROOT_WORKTREE_PATH` variable. Keep both files if you use both tools; there's no import or merge between them today.
